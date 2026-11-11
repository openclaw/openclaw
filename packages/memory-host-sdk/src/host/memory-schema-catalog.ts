import { MEMORY_EMBEDDING_CACHE_TABLE } from "./memory-schema-base.js";
import { readGeneratedSqliteCatalog, type SqliteSchemaSource } from "./openclaw-runtime-sqlite.js";

/** Deprecated custom cache identifiers use the same generated facts as the canonical table. */
export function memorySchemaSource(schemaSql: string, cacheTable: string): SqliteSchemaSource {
  if (cacheTable === MEMORY_EMBEDDING_CACHE_TABLE) {
    return schemaSql;
  }
  const catalog = readGeneratedSqliteCatalog(schemaSql);
  if (!catalog) {
    throw new Error("Memory schema has no generated catalog; run pnpm db:postgres:gen.");
  }
  // Only generated text is substituted; no persisted SQL is interpreted or normalized away.
  const rename = (text: string) => text.replaceAll(MEMORY_EMBEDDING_CACHE_TABLE, cacheTable);
  return {
    views: catalog.views,
    // eslint-disable-next-line oxc/no-map-spread -- Generated facts are shared; custom names require copy-on-write.
    tables: catalog.tables.map((table) =>
      table.name !== MEMORY_EMBEDDING_CACHE_TABLE
        ? table
        : {
            ...table,
            name: cacheTable,
            sql: table.sql === null ? null : rename(table.sql),
            indexes: table.indexes.map((index) => ({
              ...index,
              name:
                index.name === "idx_memory_embedding_cache_updated_at"
                  ? "idx_embedding_cache_updated_at"
                  : rename(index.name),
              sql:
                index.sql === null
                  ? null
                  : rename(index.sql).replace(
                      `idx_${cacheTable}_updated_at`,
                      "idx_embedding_cache_updated_at",
                    ),
            })),
          },
    ),
  };
}
