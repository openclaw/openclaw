import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { decodeMemoryEmbedding, encodeMemoryEmbedding } from "./embedding-vector.js";
import {
  buildMemoryEmbeddingCacheSchema,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_SCHEMA_SQL,
} from "./memory-schema-base.js";
import {
  dropMemoryChunkFtsTriggers,
  ensureMemoryChunkFtsTriggers,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS,
  rebuildMemoryChunkFts,
} from "./memory-schema-fts.js";
import { ensureMemoryRecallMetadataSchema } from "./memory-schema-recall.js";
import {
  assertSqliteSchemaContains,
  runSqliteImmediateTransactionSync,
} from "./openclaw-runtime-sqlite.js";

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

const CHUNK_INDEXES = [
  { name: "idx_memory_index_chunks_path_source", columns: "path, source" },
  { name: "idx_memory_index_chunks_path", columns: "path" },
  { name: "idx_memory_index_chunks_source", columns: "source" },
];
const CHUNK_REVISION_TRIGGERS = ["insert", "update", "delete"].map((event) => ({
  name: `memory_index_chunks_revision_after_${event}`,
  sql: `CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_${event}
    AFTER ${event.toUpperCase()} ON memory_index_chunks
    BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;`,
}));
const INLINE_RECALL_COLUMNS = [
  ["importance", "importance INTEGER CHECK (importance IS NULL OR importance BETWEEN 1 AND 10)"],
  ["triggers", "triggers TEXT"],
  ["project_key", "project_key TEXT"],
] as const;

type StorageShape = "absent" | "legacy" | "binary";

function storageShape(db: DatabaseSync, table: string, chunks: boolean): StorageShape {
  const tableColumns = columns(db, table);
  if (tableColumns.size === 0) {
    return "absent";
  }
  const shape =
    tableColumns.get("embedding") === "TEXT"
      ? "legacy"
      : tableColumns.get("embedding") === "BLOB"
        ? "binary"
        : undefined;
  if (!shape || (chunks && tableColumns.has("chunk_rowid") !== (shape === "binary"))) {
    throw new Error(`Unsupported partial memory storage schema: ${table}`);
  }
  let schema = chunks
    ? shape === "legacy"
      ? LEGACY_CHUNK_SCHEMA
      : MEMORY_INDEX_CHUNKS_SCHEMA_SQL
    : shape === "legacy"
      ? legacyCacheSchema(table)
      : buildMemoryEmbeddingCacheSchema(table);
  if (chunks) {
    const inline = INLINE_RECALL_COLUMNS.filter(([name]) => tableColumns.has(name));
    if (inline.length > 0) {
      schema = schema.replace(
        "updated_at INTEGER NOT NULL",
        `updated_at INTEGER NOT NULL,\n${inline.map(([, declaration]) => declaration).join(",\n")}`,
      );
    }
  }
  if (
    shape === "legacy" &&
    db.prepare("SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?").get(table)
      ?.strict === 0
  ) {
    schema = schema.replace(") STRICT;", ");");
  }
  const indexes = chunks
    ? CHUNK_INDEXES
    : [
        {
          name:
            table === MEMORY_EMBEDDING_CACHE_TABLE
              ? "idx_memory_embedding_cache_updated_at"
              : "idx_embedding_cache_updated_at",
          columns: "updated_at",
        },
      ];
  schema += indexes
    .map((index) => `CREATE INDEX ${index.name} ON ${table}(${index.columns});`)
    .join("\n");
  assertSqliteSchemaContains(db, `memory storage ${table}`, schema, {
    // Current tables are not rebuilt; preserve the agent owner's compatible
    // nullable additions while refusing every extra column on conversion input.
    allowCompatibleAdditiveColumns: shape === "binary",
    allowedMissingIndexes: indexes.map((index) => index.name),
    optionalCanonicalTriggerGroups: chunks
      ? [
          { tableName: table, triggers: CHUNK_REVISION_TRIGGERS },
          ...(shape === "binary"
            ? [{ tableName: table, triggers: MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS }]
            : []),
        ]
      : [],
  });
  if (shape === "legacy") {
    assertKnownRebuildDependents(
      db,
      table,
      indexes.map((index) => index.name),
      chunks ? CHUNK_REVISION_TRIGGERS.map((trigger) => trigger.name) : [],
    );
  }
  return shape;
}

function assertKnownRebuildDependents(
  db: DatabaseSync,
  table: string,
  indexes: string[],
  triggers: string[],
): void {
  const known = new Set([...indexes, ...triggers]);
  // Follow the agent identity migration's refusal policy: a new representation
  // cannot silently delete or reinterpret database-local dependents.
  const dependent = db
    .prepare(`
    SELECT type, name, tbl_name FROM main.sqlite_schema
    WHERE (type IN ('trigger', 'index') AND tbl_name = ? AND sql IS NOT NULL)
       OR (type IN ('view', 'trigger') AND instr(lower(sql), ?) > 0)
  `)
    .all(table, table)
    .find((row) => row.tbl_name !== table || !known.has(String(row.name)));
  if (dependent) {
    throw new Error(
      `Memory storage migration cannot rebuild unknown ${String(dependent.type)} ${String(dependent.name)} on ${table}`,
    );
  }
  for (const row of db.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table'").all()) {
    const name = String(row.name);
    const references = db
      .prepare(`PRAGMA main.foreign_key_list("${name.replaceAll('"', '""')}")`)
      .all()
      .filter((key) => key.table === table);
    const knownChild =
      table === "memory_index_chunks" &&
      ["memory_index_chunk_provenance", "memory_index_chunk_recall_metadata"].includes(name);
    if (
      references.some(
        (key) =>
          !knownChild ||
          key.from !== "chunk_id" ||
          key.to !== "id" ||
          key.on_delete !== "CASCADE" ||
          key.on_update !== "NO ACTION",
      )
    ) {
      throw new Error(
        `Memory storage migration cannot rebuild ${table} referenced by an unknown foreign key in ${name}`,
      );
    }
  }
}

function storageShapes(db: DatabaseSync, cacheTable: string) {
  return {
    chunks: storageShape(db, "memory_index_chunks", true),
    cache: storageShape(db, cacheTable, false),
  };
}

function assertBinaryEmbeddings(db: DatabaseSync, table: string): void {
  if (
    db
      .prepare(
        `SELECT 1 FROM ${table} WHERE openclaw_memory_embedding_blob_valid(embedding) = 0 LIMIT 1`,
      )
      .get()
  ) {
    throw new Error(`Memory storage migration found invalid binary embeddings in ${table}`);
  }
}

function legacyEmbedding(raw: SQLInputValue): number[] | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) &&
      parsed.every((value) => typeof value === "number" && Number.isFinite(value))
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Only migrations/imports interpret the retired JSON representation. */
export function registerMemoryEmbeddingMigrationFunctions(
  db: DatabaseSync,
  renewAuthority?: () => void,
): void {
  let renewedAt = Number.NEGATIVE_INFINITY;
  const renew = () => {
    if (!renewAuthority) {
      return;
    }
    const now = performance.now();
    if (now - renewedAt >= 1_000) {
      renewAuthority();
      renewedAt = now;
    }
  };
  db.function("openclaw_memory_embedding_from_json", { deterministic: true }, (raw) => {
    renew();
    return encodeMemoryEmbedding(legacyEmbedding(raw) ?? []);
  });
  db.function("openclaw_memory_embedding_json_valid", { deterministic: true }, (raw) => {
    renew();
    return Number(legacyEmbedding(raw) !== undefined);
  });
  db.function("openclaw_memory_embedding_blob_valid", { deterministic: true }, (raw) => {
    renew();
    return Number(
      raw instanceof Uint8Array &&
        raw.byteLength % 8 === 0 &&
        decodeMemoryEmbedding(raw).length * 8 === raw.byteLength,
    );
  });
}

function existingStorageObjects(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`SELECT sql FROM main.sqlite_schema
    WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name`)
    .all(table)
    .map((row) => String(row.sql));
}

/** Record regeneration debt after a legacy import has verified its canonical copy. */
export function markInvalidImportedMemoryEmbeddings(db: DatabaseSync, schema: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) {
    throw new Error("Invalid legacy memory schema identifier");
  }
  const invalidChunks = `
    SELECT chunk.path, chunk.source
    FROM ${schema}.chunks AS legacy
    JOIN main.memory_index_chunks AS chunk ON chunk.id = legacy.id
    WHERE openclaw_memory_embedding_json_valid(legacy.embedding) = 0
      AND length(chunk.embedding) = 0`;
  db.exec(`
    UPDATE main.memory_index_sources SET hash = ''
    WHERE (path, source) IN (${invalidChunks});
    INSERT INTO main.memory_index_meta (key, value)
    SELECT 'memory_vector_rebuild_v1', '1' WHERE EXISTS (${invalidChunks})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
}

function columns(db: DatabaseSync, table: string): Map<string, string> {
  return new Map(
    db
      .prepare("SELECT name, type FROM pragma_table_info(?)")
      .all(table)
      .map((row) => [String(row.name), String(row.type).toUpperCase()]),
  );
}

/**
 * Convert only memory storage, without provider calls. The agent migration owner
 * supplies its admitted transaction with foreign keys disabled before BEGIN.
 * Standalone/shadow index owners receive the same atomic conversion here.
 */
export function migrateMemoryIndexStorage(
  db: DatabaseSync,
  options: { embeddingCacheTable?: string; renewAuthority?: () => void } = {},
): void {
  const cacheTable = options.embeddingCacheTable ?? MEMORY_EMBEDDING_CACHE_TABLE;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(cacheTable)) {
    throw new Error("Invalid memory embedding cache table identifier");
  }
  const shapes = storageShapes(db, cacheTable);
  const migrateChunks = shapes.chunks === "legacy";
  const migrateCache = shapes.cache === "legacy";
  if (!migrateChunks && !migrateCache) {
    return;
  }
  const foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys) !== 0;
  if (migrateChunks && foreignKeys && db.isTransaction) {
    throw new Error("Memory storage migration requires foreign keys disabled before BEGIN");
  }
  if (migrateChunks && foreignKeys) {
    db.exec("PRAGMA foreign_keys = OFF");
  }
  try {
    runSqliteImmediateTransactionSync(db, () => {
      const current = storageShapes(db, cacheTable);
      if (current.chunks !== shapes.chunks || current.cache !== shapes.cache) {
        throw new Error("Memory storage schema changed before migration admission");
      }
      registerMemoryEmbeddingMigrationFunctions(db, options.renewAuthority);
      const chunkObjects = migrateChunks ? existingStorageObjects(db, "memory_index_chunks") : [];
      const cacheObjects = migrateCache ? existingStorageObjects(db, cacheTable) : [];
      if (current.chunks === "binary") {
        assertBinaryEmbeddings(db, "memory_index_chunks");
      }
      if (current.cache === "binary") {
        assertBinaryEmbeddings(db, cacheTable);
      }
      if (migrateChunks) {
        ensureMemoryRecallMetadataSchema(db);
        // Keep text and provenance searchable, but never invent a vector from
        // malformed legacy JSON. Source sync owns regeneration of these rows.
        db.exec(`
          UPDATE memory_index_sources SET hash = ''
          WHERE (path, source) IN (
            SELECT path, source FROM memory_index_chunks
            WHERE openclaw_memory_embedding_json_valid(embedding) = 0
          );
          INSERT INTO memory_index_meta (key, value)
          SELECT 'memory_vector_rebuild_v1', '1'
          WHERE EXISTS (
            SELECT 1 FROM memory_index_chunks
            WHERE openclaw_memory_embedding_json_valid(embedding) = 0
          )
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        `);
        dropMemoryChunkFtsTriggers(db);
        db.exec(
          MEMORY_INDEX_CHUNKS_SCHEMA_SQL.replace(
            "CREATE TABLE IF NOT EXISTS",
            "CREATE TABLE",
          ).replace("memory_index_chunks", "memory_index_chunks_storage_migration"),
        );
        db.exec(`
          INSERT INTO memory_index_chunks_storage_migration (
            chunk_rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
          )
          SELECT rowid, id, path, source, start_line, end_line, hash, model, text,
                 openclaw_memory_embedding_from_json(embedding), updated_at
          FROM memory_index_chunks;
          DROP TABLE memory_index_chunks;
          ALTER TABLE memory_index_chunks_storage_migration RENAME TO memory_index_chunks;
        `);
        for (const sql of chunkObjects) {
          db.exec(sql);
        }
        if (
          db
            .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get(MEMORY_INDEX_FTS_TABLE)
        ) {
          rebuildMemoryChunkFts(db, MEMORY_INDEX_FTS_TABLE);
          ensureMemoryChunkFtsTriggers(db);
        }
      }
      if (migrateCache) {
        const replacement = `${cacheTable}_storage_migration`;
        db.exec(
          buildMemoryEmbeddingCacheSchema(replacement).replace(
            "CREATE TABLE IF NOT EXISTS",
            "CREATE TABLE",
          ),
        );
        // Empty vectors retain a cache miss for malformed entries. Provider
        // identity, age, and rowid eviction order survive the conversion.
        db.exec(`
          INSERT INTO ${replacement} (rowid, provider, model, provider_key, hash, embedding, dims, updated_at)
          SELECT rowid, provider, model, provider_key, hash,
                 openclaw_memory_embedding_from_json(embedding), dims, updated_at
          FROM ${cacheTable};
          DROP TABLE ${cacheTable};
          ALTER TABLE ${replacement} RENAME TO ${cacheTable};
        `);
        for (const sql of cacheObjects) {
          db.exec(sql);
        }
      }
      if (migrateChunks) {
        for (const table of [
          "memory_index_chunk_provenance",
          "memory_index_chunk_recall_metadata",
        ]) {
          if (
            columns(db, table).size > 0 &&
            db.prepare(`PRAGMA foreign_key_check(${table})`).all().length > 0
          ) {
            throw new Error("Memory storage migration failed foreign key validation");
          }
        }
      }
    });
  } finally {
    if (options.renewAuthority) {
      // The connection may outlive its admitted migration. Later imports must
      // not retain the finished owner's renewal capability.
      registerMemoryEmbeddingMigrationFunctions(db);
    }
    if (migrateChunks && foreignKeys) {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}
