export type PreparedToolSchemaNormalization = {
  readonly source: object;
  readonly inputJson: string;
};

type SchemaCacheEntry<T> = {
  key: string;
  value: T;
};

let preparedSchemas: ReadonlyMap<object, PreparedToolSchemaNormalization> | undefined;

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

function createBoundedSchemaCache<T>(maxEntries: number) {
  const schemas = new WeakMap<object, Array<SchemaCacheEntry<T>>>();
  return {
    get(source: object, key: string): T | undefined {
      return schemas.get(source)?.find((entry) => entry.key === key)?.value;
    },
    remember(source: object, key: string, value: T): T {
      const entries = schemas.get(source) ?? [];
      schemas.set(
        source,
        [{ key, value }, ...entries.filter((entry) => entry.key !== key)].slice(0, maxEntries),
      );
      return value;
    },
  };
}

/** Prepared variants cannot evict direct callers' identity-preserving cache entries. */
export function createToolSchemaNormalizationCache<T>(maxEntries: number) {
  const directCache = createBoundedSchemaCache<T>(maxEntries);
  const preparedCache = createBoundedSchemaCache<{ inputJson: string; outputJson: string }>(
    maxEntries,
  );
  return {
    get(source: object, key: string): T | undefined {
      const prepared = preparedSchemas?.get(source);
      if (!prepared) {
        return directCache.get(source, key);
      }
      const entry = preparedCache.get(prepared.source, key);
      return entry?.inputJson === prepared.inputJson
        ? (JSON.parse(entry.outputJson) as T) // SAFETY: This pool stores only this normalizer's JSON schema output.
        : undefined;
    },
    remember(source: object, key: string, value: T): T {
      const prepared = preparedSchemas?.get(source);
      if (!prepared) {
        return directCache.remember(source, key, value);
      }
      const outputJson = JSON.stringify(value);
      if (outputJson !== undefined) {
        preparedCache.remember(prepared.source, key, { inputJson: prepared.inputJson, outputJson });
      }
      return value;
    },
  };
}
