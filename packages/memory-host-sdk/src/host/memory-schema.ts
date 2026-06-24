// Memory Host SDK module implements memory schema behavior.
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";

// SQLite schema setup for builtin memory index, embedding cache, and FTS.

export const MEMORY_INDEX_META_TABLE = "memory_index_meta";
export const MEMORY_INDEX_SOURCES_TABLE = "memory_index_sources";
export const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";
export const MEMORY_EMBEDDING_CACHE_TABLE = "memory_embedding_cache";
export const MEMORY_INDEX_STATE_TABLE = "memory_index_state";
export const MEMORY_INDEX_FTS_TABLE = "memory_index_chunks_fts";
export const MEMORY_INDEX_VECTOR_TABLE = "memory_index_chunks_vec";

const LEGACY_MEMORY_INDEX_TRIGGERS = [
  "memory_files_revision_after_insert",
  "memory_files_revision_after_update",
  "memory_files_revision_after_delete",
  "memory_chunks_revision_after_insert",
  "memory_chunks_revision_after_update",
  "memory_chunks_revision_after_delete",
] as const;

const MEMORY_INDEX_SOURCE_COLUMNS = ["path", "source", "hash", "mtime", "size"] as const;

function tableHasExactColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  const columns = new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  return columns.size === expected.length && expected.every((column) => columns.has(column));
}

function tablePrimaryKeyColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: unknown;
    pk?: unknown;
  }>;
  return rows
    .flatMap((row) =>
      typeof row.name === "string" && typeof row.pk === "number" && row.pk > 0
        ? [{ name: row.name, pk: row.pk }]
        : [],
    )
    .toSorted((left, right) => left.pk - right.pk)
    .map((row) => row.name);
}

function tableHasPrimaryKey(
  db: DatabaseSync,
  tableName: string,
  expectedColumns: readonly string[],
): boolean {
  const columns = tablePrimaryKeyColumns(db, tableName);
  return (
    columns.length === expectedColumns.length &&
    columns.every((column, index) => column === expectedColumns[index])
  );
}

function assertLegacyRowsCopied(db: DatabaseSync, query: string, tableName: string): void {
  const row = db.prepare(query).get() as { missing?: unknown } | undefined;
  if (Number(row?.missing ?? 0) > 0) {
    throw new Error(`legacy memory ${tableName} rows conflict with canonical memory index rows`);
  }
}

function canonicalTableHasRows(db: DatabaseSync, table: string): boolean {
  return db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined;
}

function tableRowCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count?: unknown }
    | undefined;
  return Number(row?.count ?? 0);
}

// Verify a legacy table was fully copied before the caller drops it. When the
// canonical table was empty before the copy, INSERT OR IGNORE from its single
// legacy source cannot collide, so a row-count match proves every row landed.
// Only a canonical table that already held rows can hide a key whose value
// differs from legacy, so the per-row full-tuple anti-join runs only then.
// Skipping it for the common (empty) case keeps large stores (90k+ chunks,
// 170k+ cache rows) from spending the whole migration window comparing
// text/embedding blobs row by row, timing out, and rolling the savepoint back
// on every interrupt — which left the legacy tables in place and re-ran the
// migration forever.
function verifyLegacyRowsCopied(
  db: DatabaseSync,
  params: {
    canonicalPrefilled: boolean;
    legacyTable: string;
    canonicalTable: string;
    conflictQuery: string;
    label: string;
  },
): void {
  if (params.canonicalPrefilled) {
    assertLegacyRowsCopied(db, params.conflictQuery, params.label);
    return;
  }
  if (tableRowCount(db, params.canonicalTable) !== tableRowCount(db, params.legacyTable)) {
    throw new Error(`legacy memory ${params.label} rows conflict with canonical memory index rows`);
  }
}

function migrateCanonicalMemoryIndexSourcesPrimaryKey(db: DatabaseSync): void {
  if (
    !tableHasExactColumns(db, MEMORY_INDEX_SOURCES_TABLE, MEMORY_INDEX_SOURCE_COLUMNS) ||
    tableHasPrimaryKey(db, MEMORY_INDEX_SOURCES_TABLE, ["path", "source"])
  ) {
    return;
  }
  if (!tableHasPrimaryKey(db, MEMORY_INDEX_SOURCES_TABLE, ["path"])) {
    return;
  }

  db.exec("SAVEPOINT migrate_memory_index_sources_primary_key");
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS memory_index_sources_revision_after_insert;
      DROP TRIGGER IF EXISTS memory_index_sources_revision_after_update;
      DROP TRIGGER IF EXISTS memory_index_sources_revision_after_delete;

      ALTER TABLE ${MEMORY_INDEX_SOURCES_TABLE}
        RENAME TO memory_index_sources_path_pk_migration;
      CREATE TABLE ${MEMORY_INDEX_SOURCES_TABLE} (
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (path, source)
      );
      INSERT INTO ${MEMORY_INDEX_SOURCES_TABLE} (path, source, hash, mtime, size)
      SELECT path, source, hash, mtime, size FROM memory_index_sources_path_pk_migration;
      DROP TABLE memory_index_sources_path_pk_migration;
      RELEASE migrate_memory_index_sources_primary_key;
    `);
  } catch (err) {
    db.exec("ROLLBACK TO migrate_memory_index_sources_primary_key");
    db.exec("RELEASE migrate_memory_index_sources_primary_key");
    throw err;
  }
}

function migrateLegacyMemoryIndexTables(
  db: DatabaseSync,
  preservedEmbeddingCacheTable?: string,
): void {
  const hasLegacyCoreTables =
    tableHasExactColumns(db, "meta", ["key", "value"]) &&
    tableHasExactColumns(db, "files", ["path", "source", "hash", "mtime", "size"]) &&
    tableHasExactColumns(db, "chunks", [
      "id",
      "path",
      "source",
      "start_line",
      "end_line",
      "hash",
      "model",
      "text",
      "embedding",
      "updated_at",
    ]);
  if (!hasLegacyCoreTables) {
    return;
  }

  db.exec("SAVEPOINT migrate_legacy_memory_index_tables");
  try {
    const metaPrefilled = canonicalTableHasRows(db, MEMORY_INDEX_META_TABLE);
    const sourcesPrefilled = canonicalTableHasRows(db, MEMORY_INDEX_SOURCES_TABLE);
    const chunksPrefilled = canonicalTableHasRows(db, MEMORY_INDEX_CHUNKS_TABLE);
    db.exec(`
      INSERT OR IGNORE INTO ${MEMORY_INDEX_META_TABLE} (key, value)
      SELECT key, value FROM meta;

      INSERT OR IGNORE INTO ${MEMORY_INDEX_SOURCES_TABLE} (path, source, hash, mtime, size)
      SELECT path, source, hash, mtime, size FROM files;

      INSERT OR IGNORE INTO ${MEMORY_INDEX_CHUNKS_TABLE} (
        id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
      )
      SELECT id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
      FROM chunks;
    `);
    verifyLegacyRowsCopied(db, {
      canonicalPrefilled: metaPrefilled,
      legacyTable: "meta",
      canonicalTable: MEMORY_INDEX_META_TABLE,
      label: "meta",
      conflictQuery: `SELECT COUNT(*) AS missing
       FROM meta AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM ${MEMORY_INDEX_META_TABLE} AS canonical
         WHERE canonical.key = legacy.key AND canonical.value IS legacy.value
       )`,
    });
    verifyLegacyRowsCopied(db, {
      canonicalPrefilled: sourcesPrefilled,
      legacyTable: "files",
      canonicalTable: MEMORY_INDEX_SOURCES_TABLE,
      label: "files",
      conflictQuery: `SELECT COUNT(*) AS missing
       FROM files AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM ${MEMORY_INDEX_SOURCES_TABLE} AS canonical
         WHERE canonical.path = legacy.path
           AND canonical.source IS legacy.source
           AND canonical.hash IS legacy.hash
           AND canonical.mtime IS legacy.mtime
           AND canonical.size IS legacy.size
       )`,
    });
    verifyLegacyRowsCopied(db, {
      canonicalPrefilled: chunksPrefilled,
      legacyTable: "chunks",
      canonicalTable: MEMORY_INDEX_CHUNKS_TABLE,
      label: "chunks",
      conflictQuery: `SELECT COUNT(*) AS missing
       FROM chunks AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM ${MEMORY_INDEX_CHUNKS_TABLE} AS canonical
         WHERE canonical.id = legacy.id
           AND canonical.path IS legacy.path
           AND canonical.source IS legacy.source
           AND canonical.start_line IS legacy.start_line
           AND canonical.end_line IS legacy.end_line
           AND canonical.hash IS legacy.hash
           AND canonical.model IS legacy.model
           AND canonical.text IS legacy.text
           AND canonical.embedding IS legacy.embedding
           AND canonical.updated_at IS legacy.updated_at
       )`,
    });
    if (
      preservedEmbeddingCacheTable !== "embedding_cache" &&
      tableHasExactColumns(db, "embedding_cache", [
        "provider",
        "model",
        "provider_key",
        "hash",
        "embedding",
        "dims",
        "updated_at",
      ])
    ) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${MEMORY_EMBEDDING_CACHE_TABLE} (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          provider_key TEXT NOT NULL,
          hash TEXT NOT NULL,
          embedding TEXT NOT NULL,
          dims INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider, model, provider_key, hash)
        );
      `);
      const cachePrefilled = canonicalTableHasRows(db, MEMORY_EMBEDDING_CACHE_TABLE);
      db.exec(`
        INSERT OR IGNORE INTO ${MEMORY_EMBEDDING_CACHE_TABLE} (
          provider, model, provider_key, hash, embedding, dims, updated_at
        )
        SELECT provider, model, provider_key, hash, embedding, dims, updated_at
        FROM embedding_cache;
      `);
      verifyLegacyRowsCopied(db, {
        canonicalPrefilled: cachePrefilled,
        legacyTable: "embedding_cache",
        canonicalTable: MEMORY_EMBEDDING_CACHE_TABLE,
        label: "embedding_cache",
        conflictQuery: `SELECT COUNT(*) AS missing
         FROM embedding_cache AS legacy
         WHERE NOT EXISTS (
           SELECT 1 FROM ${MEMORY_EMBEDDING_CACHE_TABLE} AS canonical
           WHERE canonical.provider = legacy.provider
             AND canonical.model = legacy.model
             AND canonical.provider_key = legacy.provider_key
             AND canonical.hash = legacy.hash
             AND canonical.embedding IS legacy.embedding
             AND canonical.dims IS legacy.dims
             AND canonical.updated_at IS legacy.updated_at
         )`,
      });
      db.exec("DROP TABLE embedding_cache");
    }
    for (const trigger of LEGACY_MEMORY_INDEX_TRIGGERS) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    // FTS/vector tables are derived from canonical chunk rows. FTS can be
    // removed here; sqlite-vec cleanup waits until that extension is loaded.
    db.exec(`
      DROP TABLE IF EXISTS chunks_fts;
      DROP TABLE chunks;
      DROP TABLE files;
      DROP TABLE meta;
      RELEASE migrate_legacy_memory_index_tables;
    `);
  } catch (err) {
    db.exec("ROLLBACK TO migrate_legacy_memory_index_tables");
    db.exec("RELEASE migrate_legacy_memory_index_tables");
    throw err;
  }
}

/** Ensure canonical memory index tables and the optional FTS table exist. */
export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  /** @deprecated Omit to use the canonical memory cache table. */
  embeddingCacheTable?: string;
  cacheEnabled: boolean;
  /** @deprecated Omit to use the canonical memory FTS table. */
  ftsTable?: string;
  ftsEnabled: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
}): { ftsAvailable: boolean; ftsError?: string } {
  const embeddingCacheTable = params.embeddingCacheTable ?? MEMORY_EMBEDDING_CACHE_TABLE;
  const ftsTable = params.ftsTable ?? MEMORY_INDEX_FTS_TABLE;
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_SOURCES_TABLE} (
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      PRIMARY KEY (path, source)
    );
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_CHUNKS_TABLE} (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_STATE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO ${MEMORY_INDEX_STATE_TABLE} (id, revision) VALUES (1, 0);
  `);
  migrateCanonicalMemoryIndexSourcesPrimaryKey(params.db);
  params.db.exec(`

    CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_insert
    AFTER INSERT ON ${MEMORY_INDEX_SOURCES_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_update
    AFTER UPDATE ON ${MEMORY_INDEX_SOURCES_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_delete
    AFTER DELETE ON ${MEMORY_INDEX_SOURCES_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_insert
    AFTER INSERT ON ${MEMORY_INDEX_CHUNKS_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_update
    AFTER UPDATE ON ${MEMORY_INDEX_CHUNKS_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_delete
    AFTER DELETE ON ${MEMORY_INDEX_CHUNKS_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE INDEX IF NOT EXISTS idx_memory_index_sources_source
      ON ${MEMORY_INDEX_SOURCES_TABLE}(source);
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path_source
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(path, source);
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(path);
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(source);
  `);
  migrateLegacyMemoryIndexTables(params.db, params.embeddingCacheTable);
  if (params.cacheEnabled) {
    const updatedAtIndex =
      embeddingCacheTable === MEMORY_EMBEDDING_CACHE_TABLE
        ? "idx_memory_embedding_cache_updated_at"
        : "idx_embedding_cache_updated_at";
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS ${embeddingCacheTable} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
      CREATE INDEX IF NOT EXISTS ${updatedAtIndex}
        ON ${embeddingCacheTable}(updated_at);
    `);
  }

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      const tokenizer = params.ftsTokenizer ?? "unicode61";
      const tokenizeClause = tokenizer === "trigram" ? `, tokenize='trigram case_sensitive 0'` : "";
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `${tokenizeClause});`,
      );
      // The shipped generic-table migration and a later FTS enablement both
      // create an empty derived table beside already-canonical chunk rows.
      params.db.exec(`
        INSERT INTO ${ftsTable} (
          text, id, path, source, model, start_line, end_line
        )
        SELECT text, id, path, source, model, start_line, end_line
        FROM ${MEMORY_INDEX_CHUNKS_TABLE}
        WHERE NOT EXISTS (SELECT 1 FROM ${ftsTable} LIMIT 1);
      `);
      ftsAvailable = true;
    } catch (err) {
      const message = formatErrorMessage(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}
