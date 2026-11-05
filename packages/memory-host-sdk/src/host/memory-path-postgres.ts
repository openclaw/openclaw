/** Trusted owner columns only; shared by generated DDL and the PostgreSQL reader. */
export function memoryPathPostgresExpressions(column: "path" | "s.path") {
  const normalized = `pg_catalog.lower(pg_catalog.normalize(pg_catalog.regexp_replace(pg_catalog.replace(pg_catalog.btrim(${column}), E'\\\\', '/'), '^\\./', ''), 'NFC'))`;
  const basename = `pg_catalog.regexp_replace(${normalized}, '^.*/', '')`;
  const stem = `pg_catalog.regexp_replace(${basename}, '^(.+)\\.[^.]*$', '\\1')`;
  // Bound index entries for arbitrary TEXT paths; the reader rechecks specificity.
  const keys = [normalized, basename, stem].map((value) => `pg_catalog.md5(${value})`);
  return { normalized, basename, stem, keys };
}

export const MEMORY_PATH_POSTGRES_INDEXES = ["exact_path", "basename", "stem"].map(
  (kind, index) => {
    const name = `idx_memory_index_sources_${kind}`;
    const expression = memoryPathPostgresExpressions("path").keys[index];
    return {
      name,
      sql: `CREATE INDEX "${name}" ON "memory_index_sources" ((${expression}));`,
    };
  },
);
export const MEMORY_PATH_POSTGRES_INDEX_SQL = MEMORY_PATH_POSTGRES_INDEXES.map(
  (index) => index.sql,
).join("\n\n");
