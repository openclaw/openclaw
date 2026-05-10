import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";

export const MEMORY_INDEX_TABLE_NAMES = {
  meta: "memory_index_meta",
  files: "memory_index_files",
  chunks: "memory_index_chunks",
  vector: "memory_index_chunks_vec",
  fts: "memory_index_chunks_fts",
  embeddingCache: "memory_embedding_cache",
} as const;

export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  metaTable?: string;
  filesTable?: string;
  chunksTable?: string;
  embeddingCacheTable?: string;
  cacheEnabled: boolean;
  ftsTable?: string;
  ftsEnabled: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
}): { ftsAvailable: boolean; ftsError?: string } {
  const metaTable = params.metaTable ?? MEMORY_INDEX_TABLE_NAMES.meta;
  const filesTable = params.filesTable ?? MEMORY_INDEX_TABLE_NAMES.files;
  const chunksTable = params.chunksTable ?? MEMORY_INDEX_TABLE_NAMES.chunks;
  const embeddingCacheTable = params.embeddingCacheTable ?? MEMORY_INDEX_TABLE_NAMES.embeddingCache;
  const ftsTable = params.ftsTable ?? MEMORY_INDEX_TABLE_NAMES.fts;

  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${metaTable} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${filesTable} (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${chunksTable} (
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
  `);
  if (params.cacheEnabled) {
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
    `);
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

  ensureColumn(params.db, filesTable, "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(params.db, chunksTable, "source", "TEXT NOT NULL DEFAULT 'memory'");
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path ON ${chunksTable}(path);`,
  );
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source ON ${chunksTable}(source);`,
  );

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
