import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";

export const MEMORY_INDEX_TABLE_NAMES = {
  meta: "memory_index_meta",
  sources: "memory_index_sources",
  chunks: "memory_index_chunks",
  vector: "memory_index_chunks_vec",
  fts: "memory_index_chunks_fts",
  embeddingCache: "memory_embedding_cache",
} as const;

const MEMORY_INDEX_SCHEMA_VERSION = 1;

export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  metaTable?: string;
  sourcesTable?: string;
  chunksTable?: string;
  embeddingCacheTable?: string;
  skipCoreTables?: boolean;
  cacheEnabled: boolean;
  ftsTable?: string;
  ftsEnabled: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
}): { ftsAvailable: boolean; ftsError?: string } {
  const metaTable = params.metaTable ?? MEMORY_INDEX_TABLE_NAMES.meta;
  const sourcesTable = params.sourcesTable ?? MEMORY_INDEX_TABLE_NAMES.sources;
  const chunksTable = params.chunksTable ?? MEMORY_INDEX_TABLE_NAMES.chunks;
  const embeddingCacheTable = params.embeddingCacheTable ?? MEMORY_INDEX_TABLE_NAMES.embeddingCache;
  const ftsTable = params.ftsTable ?? MEMORY_INDEX_TABLE_NAMES.fts;

  if (!params.skipCoreTables) {
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT NOT NULL PRIMARY KEY
      );
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS ${metaTable} (
        meta_key TEXT NOT NULL PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT,
        sources_json TEXT NOT NULL,
        scope_hash TEXT NOT NULL,
        chunk_tokens INTEGER NOT NULL,
        chunk_overlap INTEGER NOT NULL,
        vector_dims INTEGER,
        fts_tokenizer TEXT NOT NULL,
        config_hash TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS ${sourcesTable} (
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT,
        session_id TEXT,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_key),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
    `);
    params.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_index_sources_session
        ON ${sourcesTable}(session_id)
        WHERE session_id IS NOT NULL;
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS ${chunksTable} (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT NOT NULL,
        session_id TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB,
        embedding_dims INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_kind, source_key)
          REFERENCES ${sourcesTable}(source_kind, source_key) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
    `);
    params.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source ON ${chunksTable}(source_kind, source_key);`,
    );
    params.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path ON ${chunksTable}(path);`,
    );
    params.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_session
        ON ${chunksTable}(session_id)
        WHERE session_id IS NOT NULL;
    `);
    if (params.cacheEnabled) {
      params.db.exec(`
        CREATE TABLE IF NOT EXISTS ${embeddingCacheTable} (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          provider_key TEXT NOT NULL,
          hash TEXT NOT NULL,
          embedding BLOB NOT NULL,
          dims INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider, model, provider_key, hash)
        );
      `);
      params.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_embedding_cache_updated_at ON ${embeddingCacheTable}(updated_at);`,
      );
    }
    params.db.exec(
      `INSERT OR IGNORE INTO ${metaTable} (meta_key, schema_version, provider, model, provider_key, sources_json, scope_hash, chunk_tokens, chunk_overlap, vector_dims, fts_tokenizer, config_hash, updated_at)
       VALUES ('schema', ${MEMORY_INDEX_SCHEMA_VERSION}, 'none', 'fts-only', NULL, '[]', '', 0, 0, NULL, 'unicode61', NULL, 0);`,
    );
  } else if (params.cacheEnabled) {
    params.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_embedding_cache_updated_at ON ${embeddingCacheTable}(updated_at);`,
    );
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
          `  source_key UNINDEXED,\n` +
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
