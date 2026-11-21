import {
  MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
} from "./memory-schema-provenance.js";
import {
  MEMORY_INDEX_CHUNK_RECALL_METADATA_SCHEMA_SQL,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
} from "./memory-schema-recall.js";
import {
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
} from "./openclaw-runtime-sqlite.js";

export const MEMORY_INDEX_META_TABLE = "memory_index_meta";
export const MEMORY_EMBEDDING_CACHE_TABLE = "memory_embedding_cache";
export const MEMORY_INDEX_STATE_TABLE = "memory_index_state";
export const MEMORY_INDEX_VECTOR_TABLE = "memory_index_chunks_vec";

export const MEMORY_INDEX_CHUNKS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_CHUNKS_TABLE} (
    chunk_rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'memory',
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    hash TEXT NOT NULL,
    model TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
`;

export function buildMemoryEmbeddingCacheSchema(table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    ) STRICT;
  `;
}

// Only rebuildable index state belongs here, in child-before-parent drop order.
// Origins, tombstones, and canonical sessions are durable owners, not index data.
export const MEMORY_INDEX_DERIVED_TABLES = [
  MEMORY_INDEX_VECTOR_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_STATE_TABLE,
] as const;

export function buildMemoryIndexStrictSchema(params: {
  embeddingCacheTable: string;
  includeEmbeddingCache: boolean;
}): string {
  const embeddingCacheSql = params.includeEmbeddingCache
    ? buildMemoryEmbeddingCacheSchema(params.embeddingCacheTable)
    : "";
  return `
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_SOURCES_TABLE} (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      UNIQUE (path, source)
    ) STRICT;
    ${MEMORY_INDEX_CHUNKS_SCHEMA_SQL}
    ${MEMORY_INDEX_CHUNK_RECALL_METADATA_SCHEMA_SQL}
    ${MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL}
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_STATE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    ) STRICT;
    ${embeddingCacheSql}
  `;
}

// Frozen pre-binary contract, including the older non-STRICT spelling below.
const LEGACY_CHUNK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_index_chunks (
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
  ) STRICT;
`;

function legacyCacheSchema(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    hash TEXT NOT NULL,
    embedding TEXT NOT NULL,
    dims INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, model, provider_key, hash)
  ) STRICT;`;
}

const MEMORY_CHUNK_STORAGE_INDEXES = [
  { name: "idx_memory_index_chunks_path_source", columns: "path, source" },
  { name: "idx_memory_index_chunks_path", columns: "path" },
  { name: "idx_memory_index_chunks_source", columns: "source" },
];

export const MEMORY_INLINE_RECALL_COLUMNS = [
  ["importance", "importance INTEGER CHECK (importance IS NULL OR importance BETWEEN 1 AND 10)"],
  ["triggers", "triggers TEXT"],
  ["project_key", "project_key TEXT"],
] as const;

/** Exact current and shipped storage fragments, shared by admission and catalog generation. */
export function buildMemoryStorageSchema(params: {
  table: string;
  chunks: boolean;
  legacy: boolean;
  strict: boolean;
  inlineRecallColumns?: readonly string[];
}): string {
  let schema = params.chunks
    ? params.legacy
      ? LEGACY_CHUNK_SCHEMA
      : MEMORY_INDEX_CHUNKS_SCHEMA_SQL
    : params.legacy
      ? legacyCacheSchema(params.table)
      : buildMemoryEmbeddingCacheSchema(params.table);
  const inline = MEMORY_INLINE_RECALL_COLUMNS.filter(([name]) =>
    params.inlineRecallColumns?.includes(name),
  );
  if (params.chunks && inline.length > 0) {
    schema = schema.replace(
      "updated_at INTEGER NOT NULL",
      `updated_at INTEGER NOT NULL,\n${inline.map(([, declaration]) => declaration).join(",\n")}`,
    );
  }
  if (!params.strict) {
    schema = schema.replace(") STRICT;", ");");
  }
  return (
    schema +
    memoryStorageIndexes(params.table, params.chunks)
      .map((index) => `CREATE INDEX ${index.name} ON ${params.table}(${index.columns});`)
      .join("\n")
  );
}

export function memoryStorageIndexes(table: string, chunks: boolean) {
  return chunks
    ? MEMORY_CHUNK_STORAGE_INDEXES
    : [
        {
          name:
            table === MEMORY_EMBEDDING_CACHE_TABLE
              ? "idx_memory_embedding_cache_updated_at"
              : "idx_embedding_cache_updated_at",
          columns: "updated_at",
        },
      ];
}
