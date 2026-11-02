import { inheritToolSchemaTruncation, wasToolSchemaTruncated } from "./tool-schema-depth.js";
import {
  getPublishedRuntimeToolInputSchema,
  publishRuntimeToolInputSchema,
} from "./tool-schema-json-projection.js";

export type PreparedToolSchemaNormalization = {
  readonly source: object;
  readonly inputJson: string;
};

let preparedSchemas: ReadonlyMap<object, PreparedToolSchemaNormalization> | undefined;

/** Request preparation already detached and depth-bounded these schemas. */
export function isPreparedToolSchemaNormalization(schema: unknown): boolean {
  return schema !== null && typeof schema === "object" && preparedSchemas?.has(schema) === true;
}

const MAX_CACHE_ENTRIES_PER_SCHEMA = 8;

/** Only synchronous conversion owns these fresh projections; no facts survive its return. */
export function withPreparedToolSchemaNormalization<T>(
  schemas: ReadonlyMap<object, PreparedToolSchemaNormalization>,
  convert: () => T,
): T {
  const previous = preparedSchemas;
  preparedSchemas = schemas;
  try {
    return convert();
  } finally {
    preparedSchemas = previous;
  }
}

function createBoundedSchemaCache<T>() {
  const schemas = new WeakMap<object, Array<{ key: string; value: T }>>();
  return {
    get(source: object, key: string): T | undefined {
      return schemas.get(source)?.find((entry) => entry.key === key)?.value;
    },
    remember(source: object, key: string, value: T): T {
      const entries = schemas.get(source) ?? [];
      schemas.set(
        source,
        [{ key, value }, ...entries.filter((entry) => entry.key !== key)].slice(
          0,
          MAX_CACHE_ENTRIES_PER_SCHEMA,
        ),
      );
      return value;
    },
  };
}

/** Prepared variants cannot evict direct callers' identity-preserving cache entries. */
export function createToolSchemaNormalizationCache<T>() {
  const directCache = createBoundedSchemaCache<T>();
  const preparedCache = createBoundedSchemaCache<{
    inputJson: string;
    inputTruncated: boolean;
    outputJson: string;
    truncated: boolean;
  }>();
  return {
    get(source: object, key: string): T | undefined {
      const prepared = preparedSchemas?.get(source);
      if (!prepared) {
        return inheritToolSchemaTruncation(source, directCache.get(source, key));
      }
      const entry = preparedCache.get(prepared.source, key);
      return entry?.inputJson === prepared.inputJson &&
        entry.inputTruncated === wasToolSchemaTruncated(source)
        ? inheritToolSchemaTruncation(
            source,
            JSON.parse(entry.outputJson) as T, // SAFETY: This pool stores only this normalizer's JSON schema output.
            entry.truncated,
          )
        : undefined;
    },
    remember(source: object, key: string, value: T): T {
      const result = inheritToolSchemaTruncation(source, value);
      const prepared = preparedSchemas?.get(source);
      if (!prepared) {
        const published = getPublishedRuntimeToolInputSchema(source)
          ? publishRuntimeToolInputSchema(result)
          : undefined;
        return directCache.remember(
          source,
          key,
          // SAFETY: This cache only stores JSON-schema outputs; publication preserves their structural type.
          published?.violations.length === 0 ? (published.schema as T) : result,
        );
      }
      const outputJson = JSON.stringify(result);
      if (outputJson !== undefined) {
        preparedCache.remember(prepared.source, key, {
          inputJson: prepared.inputJson,
          inputTruncated: wasToolSchemaTruncated(source),
          outputJson,
          truncated: wasToolSchemaTruncated(result),
        });
      }
      return result;
    },
  };
}
