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

function tableHasExactColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  const columns = new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  return columns.size === expected.length && expected.every((column) => columns.has(column));
}

function assertLegacyRowsCopied(db: DatabaseSync, query: string, tableName: string): void {
  const row = db.prepare(query).get() as { missing?: unknown } | undefined;
  if (Number(row?.missing ?? 0) > 0) {
    throw new Error(`legacy memory ${tableName} rows conflict with canonical memory index rows`);
  }
}

function migrateLegacyMemoryIndexTables(db: DatabaseSync): void {
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
    assertLegacyRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM meta AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM ${MEMORY_INDEX_META_TABLE} AS canonical
         WHERE canonical.key = legacy.key AND canonical.value IS legacy.value
       )`,
      "meta",
    );
    assertLegacyRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM files AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM ${MEMORY_INDEX_SOURCES_TABLE} AS canonical
         WHERE canonical.path = legacy.path
           AND canonical.source IS legacy.source
           AND canonical.hash IS legacy.hash
           AND canonical.mtime IS legacy.mtime
           AND canonical.size IS legacy.size
       )`,
      "files",
    );
    assertLegacyRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
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
      "chunks",
    );
    if (
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
        INSERT OR IGNORE INTO ${MEMORY_EMBEDDING_CACHE_TABLE} (
          provider, model, provider_key, hash, embedding, dims, updated_at
        )
        SELECT provider, model, provider_key, hash, embedding, dims, updated_at
        FROM embedding_cache;
      `);
      assertLegacyRowsCopied(
        db,
        `SELECT COUNT(*) AS missing
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
        "embedding_cache",
      );
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
  cacheEnabled: boolean;
  ftsEnabled: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
}): { ftsAvailable: boolean; ftsError?: string } {
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_SOURCES_TABLE} (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
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

    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(path);
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(source);
  `);
  migrateLegacyMemoryIndexTables(params.db);
  if (params.cacheEnabled) {
    params.db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_memory_embedding_cache_updated_at
        ON ${MEMORY_EMBEDDING_CACHE_TABLE}(updated_at);
    `);
  }

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      const tokenizer = params.ftsTokenizer ?? "unicode61";
      const tokenizeClause = tokenizer === "trigram" ? `, tokenize='trigram case_sensitive 0'` : "";
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORY_INDEX_FTS_TABLE} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `${tokenizeClause});`,
      );
      ftsAvailable = true;
    } catch (err) {
      const message = formatErrorMessage(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}
