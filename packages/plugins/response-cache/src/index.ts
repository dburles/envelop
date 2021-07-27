import { Plugin } from '@envelop/types';
import LRU from 'lru-cache';
import { createHash } from 'crypto';
import { DocumentNode, OperationDefinitionNode, FieldNode, SelectionNode, visit, parse, print } from 'graphql';
import isAsyncIterable from 'graphql/jsutils/isAsyncIterable.js';

type Listener = (typename: string, id?: string | number) => void;

interface Controller {
  purge(typename: string, id?: string | number): void;
  ɵregister(listener: Listener): void;
}

interface Options<C = any> {
  /**
   * Maximum size of the cache. Defaults to `Infinity`.
   */
  max?: number;
  /**
   * Maximum age in ms. Defaults to `Infinity`.
   */
  ttl?: number;
  /**
   * Overwrite the ttl for query operations whose execution result contains a specific object type.
   * Useful if the occurrence of a object time should reduce the TTL of the query.
   */
  ttlPerType?: Record<string, number>;
  /**
   * Allows to manually control the cache. Use `createController` to create a controller and pass it here.
   */
  controller?: Controller;
  /**
   * Allows to cache responses based on the resolved session id.
   * Return a unique value for each session.
   * Return `null` or `undefined` to mark the session as public/global.
   * Creates a global session by default.
   * @param context GraphQL Context
   */
  session?(context: C): string | undefined | null;
  /**
   * Skip caching of following the types.
   */
  ignoredTypes?: string[];
}

export function createController(): Controller {
  let listener: Listener = () => {};

  return {
    purge(typename, id) {
      listener(typename, id);
    },
    ɵregister(audience) {
      listener = audience;
    },
  };
}

export function useResponseCache({
  max = Infinity,
  ttl = Infinity,
  controller,
  session = () => null,
  ignoredTypes = [],
  ttlPerType = {},
}: Options = {}): Plugin {
  if (controller) {
    controller.ɵregister((typename, id) => {
      purgeEntity(typeof id !== 'undefined' ? makeId(typename, id) : typename);
    });
  }

  const cachedResponses = new LRU<string, any>({
    max: max,
    maxAge: ttl,
    stale: false,
    noDisposeOnSet: true,
    dispose(responseId) {
      purgeResponse(responseId, false);
    },
  });

  const entityToResponse = new Map<string, Set<string>>();
  const responseToEnity = new Map<string, Set<string>>();
  const ignoredTypesMap = new Set<string>(ignoredTypes);

  function purgeResponse(responseId: string, shouldRemove = true) {
    // get entities related to the response
    if (responseToEnity.has(responseId)) {
      responseToEnity.get(responseId)!.forEach(entityId => {
        // remove the response mapping from the entity
        entityToResponse.get(entityId)?.delete(responseId);
      });
      // remove all the entity mappings from the response
      responseToEnity.delete(responseId);
    }

    if (shouldRemove) {
      // remove the response from the cache
      cachedResponses.del(responseId);
    }
  }

  function purgeEntity(entity: string) {
    if (entityToResponse.has(entity)) {
      const responsesToRemove = entityToResponse.get(entity);

      if (responsesToRemove) {
        responsesToRemove.forEach(responseId => {
          purgeResponse(responseId);
        });
      }
    }
  }

  return {
    onParse(ctx) {
      ctx.setParseFn((source, options) => addTypenameToDocument(parse(source, options)));
    },
    onExecute(ctx) {
      if (isMutation(ctx.args.document)) {
        return {
          onExecuteDone({ result }) {
            if (isAsyncIterable(result)) {
              // eslint-disable-next-line no-console
              console.warn('[useResponseCache] AsyncIterable returned from execute is currently unsupported.');
              return;
            }

            const entitiesToRemove = new Set<string>();

            collectEntity(result.data, (typename, id) => {
              if (typeof id !== 'undefined') {
                entitiesToRemove.add(makeId(typename, id));
              }
            });

            entitiesToRemove.forEach(purgeEntity);
          },
        };
      } else {
        const operationId = createHash('sha1')
          .update(
            [print(ctx.args.document), JSON.stringify(ctx.args.variableValues || {}), session(ctx.args.contextValue) ?? ''].join(
              '|'
            )
          )
          .digest('base64');

        if (cachedResponses.has(operationId)) {
          ctx.setResultAndStopExecution(cachedResponses.get(operationId));
          return;
        }

        return {
          onExecuteDone({ result }) {
            if (isAsyncIterable(result)) {
              // eslint-disable-next-line no-console
              console.warn('[useResponseCache] AsyncIterable returned from execute is currently unsupported.');
              return;
            }

            let skip = false;
            const collectedEntities: [string, string | undefined][] = [];

            let ttlForOperation = ttl;

            collectEntity(result.data, (typename, id) => {
              skip = skip || ignoredTypesMap.has(typename);

              if (typename in ttlPerType) {
                ttlForOperation = Math.min(ttlForOperation, ttlPerType[typename]);
              }

              if (!skip) {
                collectedEntities.push([typename, id]);
              }
            });

            if (skip) {
              return;
            }

            cachedResponses.set(operationId, result, ttlForOperation);
            responseToEnity.set(operationId, new Set());

            for (const [typename, id] of collectedEntities) {
              if (!entityToResponse.has(typename)) {
                entityToResponse.set(typename, new Set());
              }

              // typename => operation
              entityToResponse.get(typename)!.add(operationId);
              // operation => typename
              responseToEnity.get(operationId)!.add(typename);

              if (typeof id !== 'undefined') {
                const eid = makeId(typename, id);

                if (!entityToResponse.has(eid)) {
                  entityToResponse.set(eid, new Set());
                }

                // typename:id => operation
                entityToResponse.get(eid)!.add(operationId);
                // operation => typename:id
                responseToEnity.get(operationId)!.add(eid);
              }
            }
          },
        };
      }
    },
  };
}

function isOperationDefinition(node: any): node is OperationDefinitionNode {
  return node?.kind === 'OperationDefinition';
}

function isMutation(doc: DocumentNode) {
  return doc.definitions.find(isOperationDefinition)!.operation === 'mutation';
}

function makeId(typename: string, id: number | string): string {
  return `${typename}:${id}`;
}

function collectEntity(data: any, add: (typename: string, id?: string) => void) {
  if (!data) {
    return;
  }

  if (typeof data === 'object') {
    for (const field in data) {
      const value = data[field];

      if (field === '__typename') {
        add(value);

        if ('id' in data) {
          add(value, data.id);
        }
      } else {
        collectEntity(value, add);
      }
    }
  } else if (Array.isArray(data)) {
    for (const obj of data) {
      collectEntity(obj, add);
    }
  }
}

const TYPENAME_FIELD: FieldNode = {
  kind: 'Field',
  name: {
    kind: 'Name',
    value: '__typename',
  },
};

function addTypenameToDocument(doc: DocumentNode): DocumentNode {
  return visit(doc, {
    SelectionSet: {
      enter(node, _key, parent) {
        if (parent && isOperationDefinition(parent)) {
          return;
        }

        if (!node.selections) {
          return;
        }

        const skip = node.selections.some(selection => {
          return isField(selection) && (selection.name.value === '__typename' || selection.name.value.lastIndexOf('__', 0) === 0);
        });

        if (skip) {
          return;
        }

        return {
          ...node,
          selections: [...node.selections, TYPENAME_FIELD],
        };
      },
    },
  });
}

function isField(selection: SelectionNode): selection is FieldNode {
  return selection.kind === 'Field';
}
