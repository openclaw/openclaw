import fsSync from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryChunkFtsTriggers,
  markInvalidImportedMemoryEmbeddings,
  rebuildMemoryChunkFts,
  registerMemoryEmbeddingMigrationFunctions,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";

export type LegacyMemorySidecarSource = {
  agentId: string;
  legacyPath: string;
  stateDir: string;
  agentDatabasePath: string;
};

const LEGACY_MEMORY_SIDECAR_SCHEMA = "legacy_memory_sidecar";
const LEGACY_MEMORY_VECTOR_TABLE = "chunks_vec";
const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

// The first column is the row identity; other values need null-safe IS comparisons.
const LEGACY_MEMORY_INDEX_TABLES = [
  ["meta", MEMORY_INDEX_META_TABLE, ["key", "value"]],
  ["files", MEMORY_INDEX_SOURCES_TABLE, ["path", "source", "hash", "mtime", "size"]],
  [
    "chunks",
    MEMORY_INDEX_CHUNKS_TABLE,
    [
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
    ],
  ],
] as const;
const LEGACY_MEMORY_CACHE_COLUMNS = [
  "provider",
  "model",
  "provider_key",
  "hash",
  "embedding",
  "dims",
  "updated_at",
] as const;

type LegacyMemorySidecarImportResult = {
  imported: boolean;
  reason?: "missing-sidecar" | "legacy-schema-missing";
  sources: number;
  chunks: number;
  cacheEntries: number;
  vectorEntries: number | undefined;
  vectorEntriesImported: boolean;
};

export class LegacyMemoryDerivedRowsConflictError extends Error {
  constructor(readonly tableName: string) {
    super(`legacy memory ${tableName} rows conflict with canonical memory index rows`);
  }
}

function tableExists(db: DatabaseSync, schema: string, tableName: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE name = ?`).get(tableName));
}

function tableHasColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
  schema: string,
  exact = false,
): boolean {
  const rows = db.prepare(`PRAGMA ${schema}.table_info(${tableName})`).all() as Array<{
    name?: unknown;
  }>;
  const columns = new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  return (
    (!exact || columns.size === expected.length) && expected.every((column) => columns.has(column))
  );
}

function hasLegacyMemoryIndexTables(db: DatabaseSync, schema: string): boolean {
  return LEGACY_MEMORY_INDEX_TABLES.every(([tableName, , columns]) =>
    tableHasColumns(db, tableName, columns, schema, true),
  );
}

function hasLegacyEmbeddingCacheTable(db: DatabaseSync, schema: string): boolean {
  return tableHasColumns(db, "embedding_cache", LEGACY_MEMORY_CACHE_COLUMNS, schema, true);
}

function hasLegacyVectorTable(db: DatabaseSync, schema: string): boolean {
  return tableHasColumns(db, LEGACY_MEMORY_VECTOR_TABLE, ["id", "embedding"], schema);
}

function tableRowCount(db: DatabaseSync, schema: string, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${schema}.${tableName}`).get() as
    | { count?: unknown }
    | undefined;
  return Number(row?.count ?? 0);
}

function readLegacySidecarCounts(
  db: DatabaseSync,
  schema: string,
  options: { copyVectorRows: boolean },
): Pick<LegacyMemorySidecarImportResult, "sources" | "chunks" | "cacheEntries" | "vectorEntries"> {
  const vectorEntries = readLegacyVectorEntries(db, schema, !options.copyVectorRows);
  return {
    sources: tableRowCount(db, schema, "files"),
    chunks: tableRowCount(db, schema, "chunks"),
    cacheEntries: hasLegacyEmbeddingCacheTable(db, schema)
      ? tableRowCount(db, schema, "embedding_cache")
      : 0,
    vectorEntries,
  };
}

function readLegacyVectorEntries(
  db: DatabaseSync,
  schema: string,
  tolerateInvalid: boolean,
): number | undefined {
  if (!tableExists(db, schema, LEGACY_MEMORY_VECTOR_TABLE)) {
    return 0;
  }
  try {
    return hasLegacyVectorTable(db, schema)
      ? tableRowCount(db, schema, LEGACY_MEMORY_VECTOR_TABLE)
      : undefined;
  } catch (error) {
    if (!tolerateInvalid) {
      throw error;
    }
    return undefined;
  }
}

function assertLegacyDerivedRowsCopied(db: DatabaseSync, query: string, tableName: string): void {
  const row = db.prepare(query).get() as { missing?: unknown } | undefined;
  if (Number(row?.missing ?? 0) > 0) {
    throw new LegacyMemoryDerivedRowsConflictError(tableName);
  }
}

function assertLegacyVectorRowsReferenceChunks(db: DatabaseSync, schema: string): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS missing
       FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk
         WHERE chunk.id = legacy.id
       )`,
    )
    .get() as { missing?: unknown } | undefined;
  if (Number(row?.missing ?? 0) > 0) {
    throw new Error(`legacy memory ${LEGACY_MEMORY_VECTOR_TABLE} rows reference missing chunks`);
  }
}

function readMemoryIndexMetaVectorDimensions(
  db: DatabaseSync,
  schema: string,
  tableName: string,
): number | undefined {
  if (!tableExists(db, schema, tableName)) {
    return undefined;
  }
  const meta = db
    .prepare(`SELECT value FROM ${schema}.${tableName} WHERE key = ?`)
    .get(MEMORY_INDEX_META_KEY) as { value?: unknown } | undefined;
  if (typeof meta?.value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(meta.value) as { vectorDims?: unknown };
    const dimensions = Number(parsed.vectorDims);
    return Number.isSafeInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
  } catch {}
  return undefined;
}

function readVectorTableSqlDimensions(
  db: DatabaseSync,
  schema: string,
  tableName: string,
): number | undefined {
  const row = db
    .prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE name = ?`)
    .get(tableName) as { sql?: unknown } | undefined;
  if (typeof row?.sql !== "string") {
    return undefined;
  }
  const match = /embedding\s+FLOAT\[(\d+)\]/i.exec(row.sql);
  const dimensions = Number(match?.[1] ?? 0);
  return Number.isSafeInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
}

function readLegacyVectorDimensions(db: DatabaseSync, schema: string): number | undefined {
  const configuredDimensions =
    readMemoryIndexMetaVectorDimensions(db, schema, "meta") ??
    readVectorTableSqlDimensions(db, schema, LEGACY_MEMORY_VECTOR_TABLE);
  if (configuredDimensions) {
    return configuredDimensions;
  }
  const row = db
    .prepare(
      `SELECT length(embedding) AS bytes FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} WHERE embedding IS NOT NULL LIMIT 1`,
    )
    .get() as { bytes?: unknown } | undefined;
  const bytes = Number(row?.bytes ?? 0);
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes % Float32Array.BYTES_PER_ELEMENT === 0
    ? bytes / Float32Array.BYTES_PER_ELEMENT
    : undefined;
}

function ensureCanonicalVectorTableForLegacyRows(db: DatabaseSync, schema: string): void {
  if (
    !hasLegacyVectorTable(db, schema) ||
    tableRowCount(db, schema, LEGACY_MEMORY_VECTOR_TABLE) === 0
  ) {
    return;
  }
  const dimensions = readLegacyVectorDimensions(db, schema);
  if (!dimensions) {
    throw new Error("legacy memory chunks_vec rows require vector dimensions before import");
  }
  if (tableExists(db, "main", MEMORY_INDEX_VECTOR_TABLE)) {
    const canonicalDimensions =
      readVectorTableSqlDimensions(db, "main", MEMORY_INDEX_VECTOR_TABLE) ??
      readMemoryIndexMetaVectorDimensions(db, "main", MEMORY_INDEX_META_TABLE);
    if (!canonicalDimensions) {
      throw new Error(
        "canonical memory chunks_vec table requires vector dimensions before legacy import",
      );
    }
    if (canonicalDimensions !== dimensions) {
      throw new Error(
        `legacy memory chunks_vec dimensions ${dimensions} do not match canonical memory chunks_vec dimensions ${canonicalDimensions}`,
      );
    }
    return;
  }
  const canonicalMetaDimensions = readMemoryIndexMetaVectorDimensions(
    db,
    "main",
    MEMORY_INDEX_META_TABLE,
  );
  if (canonicalMetaDimensions && canonicalMetaDimensions !== dimensions) {
    throw new Error(
      `legacy memory chunks_vec dimensions ${dimensions} do not match canonical memory chunks_vec dimensions ${canonicalMetaDimensions}`,
    );
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS main.${MEMORY_INDEX_VECTOR_TABLE} USING vec0(\n` +
      `  id TEXT PRIMARY KEY,\n` +
      `  embedding FLOAT[${dimensions}]\n` +
      `)`,
  );
}

function copyLegacyMemoryVectorRows(db: DatabaseSync, schema: string): void {
  if (!hasLegacyVectorTable(db, schema)) {
    return;
  }
  ensureCanonicalVectorTableForLegacyRows(db, schema);
  if (!tableExists(db, "main", MEMORY_INDEX_VECTOR_TABLE)) {
    return;
  }
  assertLegacyVectorRowsReferenceChunks(db, schema);
  assertLegacyDerivedRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
     JOIN main.${MEMORY_INDEX_VECTOR_TABLE} AS canonical ON canonical.id = legacy.id
     WHERE canonical.embedding IS NOT legacy.embedding`,
    LEGACY_MEMORY_VECTOR_TABLE,
  );
  db.exec(`
    INSERT OR IGNORE INTO main.${MEMORY_INDEX_VECTOR_TABLE} (id, embedding)
    SELECT legacy.id, legacy.embedding
    FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
    JOIN main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk ON chunk.id = legacy.id
    WHERE NOT EXISTS (
      SELECT 1 FROM main.${MEMORY_INDEX_VECTOR_TABLE} AS canonical
      WHERE canonical.id = legacy.id
    );
  `);
  assertLegacyDerivedRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_VECTOR_TABLE} AS canonical
       WHERE canonical.id = legacy.id
         AND canonical.embedding IS legacy.embedding
     )`,
    LEGACY_MEMORY_VECTOR_TABLE,
  );
}

function copyLegacyMemoryIndexRows(
  db: DatabaseSync,
  schema: string,
  options: { copyVectorRows: boolean },
): void {
  registerMemoryEmbeddingMigrationFunctions(db);
  const legacyValue = (column: string) =>
    column === "embedding"
      ? "openclaw_memory_embedding_from_json(legacy.embedding)"
      : `legacy.${column}`;
  db.exec(
    LEGACY_MEMORY_INDEX_TABLES.map(
      ([legacy, canonical, columns]) => `
        INSERT OR IGNORE INTO main.${canonical} (${columns.join(", ")})
        SELECT ${columns.map(legacyValue).join(", ")} FROM ${schema}.${legacy} AS legacy;`,
    ).join("\n"),
  );
  for (const [legacy, canonical, columns] of LEGACY_MEMORY_INDEX_TABLES) {
    const matches = columns.map(
      (column, index) => `canonical.${column} ${index === 0 ? "=" : "IS"} ${legacyValue(column)}`,
    );
    assertLegacyDerivedRowsCopied(
      db,
      `SELECT COUNT(*) AS missing FROM ${schema}.${legacy} AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${canonical} AS canonical WHERE ${matches.join(" AND ")}
       )`,
      legacy,
    );
  }
  if (tableExists(db, "main", MEMORY_INDEX_FTS_TABLE)) {
    rebuildMemoryChunkFts(db, MEMORY_INDEX_FTS_TABLE);
    ensureMemoryChunkFtsTriggers(db);
  }
  if (options.copyVectorRows) {
    copyLegacyMemoryVectorRows(db, schema);
  }
  if (hasLegacyEmbeddingCacheTable(db, schema)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS main.${MEMORY_EMBEDDING_CACHE_TABLE} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      ) STRICT;
      INSERT OR IGNORE INTO main.${MEMORY_EMBEDDING_CACHE_TABLE} (
        provider, model, provider_key, hash, embedding, dims, updated_at
      )
      SELECT provider, model, provider_key, hash, openclaw_memory_embedding_from_json(embedding), dims, updated_at
      FROM ${schema}.embedding_cache;
    `);
    // Matching cache keys are derived rows. Validate shape before deciding whether the
    // entire stale sidecar should yield to the canonical index.
    assertLegacyDerivedRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM ${schema}.embedding_cache AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_EMBEDDING_CACHE_TABLE} AS canonical
         WHERE canonical.provider = legacy.provider
           AND canonical.model = legacy.model
           AND canonical.provider_key = legacy.provider_key
           AND canonical.hash = legacy.hash
           AND canonical.dims IS legacy.dims
           AND (
             canonical.embedding IS openclaw_memory_embedding_from_json(legacy.embedding)
             OR (
               openclaw_memory_embedding_blob_valid(canonical.embedding) = 1
               AND length(canonical.embedding) = canonical.dims * 8
               AND CASE WHEN openclaw_memory_embedding_json_valid(legacy.embedding) = 1
                   THEN json_array_length(legacy.embedding) = legacy.dims ELSE 0 END
             )
           )
       )`,
      "embedding_cache",
    );
  }
  markInvalidImportedMemoryEmbeddings(db, schema);
}

export function importLegacyMemorySidecarIndex(params: {
  db: DatabaseSync;
  legacySidecarDatabasePath: string | undefined;
  copyVectorRows: boolean;
  requireVectorRows: boolean;
}): LegacyMemorySidecarImportResult {
  if (!params.legacySidecarDatabasePath || !fsSync.existsSync(params.legacySidecarDatabasePath)) {
    return {
      imported: false,
      reason: "missing-sidecar",
      sources: 0,
      chunks: 0,
      cacheEntries: 0,
      vectorEntries: 0,
      vectorEntriesImported: true,
    };
  }
  params.db
    .prepare(`ATTACH DATABASE ? AS ${LEGACY_MEMORY_SIDECAR_SCHEMA}`)
    .run(params.legacySidecarDatabasePath);
  try {
    if (!hasLegacyMemoryIndexTables(params.db, LEGACY_MEMORY_SIDECAR_SCHEMA)) {
      return {
        imported: false,
        reason: "legacy-schema-missing",
        sources: 0,
        chunks: 0,
        cacheEntries: 0,
        vectorEntries: 0,
        vectorEntriesImported: true,
      };
    }
    const counts = readLegacySidecarCounts(params.db, LEGACY_MEMORY_SIDECAR_SCHEMA, {
      copyVectorRows: params.copyVectorRows,
    });
    params.db.exec("SAVEPOINT import_legacy_sidecar_memory_index");
    try {
      copyLegacyMemoryIndexRows(params.db, LEGACY_MEMORY_SIDECAR_SCHEMA, {
        copyVectorRows: params.copyVectorRows,
      });
      params.db.exec("RELEASE import_legacy_sidecar_memory_index");
      return {
        imported: true,
        ...counts,
        vectorEntriesImported:
          counts.vectorEntries === 0 ||
          !params.requireVectorRows ||
          (params.copyVectorRows && counts.vectorEntries !== undefined),
      };
    } catch (err) {
      params.db.exec("ROLLBACK TO import_legacy_sidecar_memory_index");
      params.db.exec("RELEASE import_legacy_sidecar_memory_index");
      throw err;
    }
  } finally {
    params.db.exec(`DETACH DATABASE ${LEGACY_MEMORY_SIDECAR_SCHEMA}`);
  }
}
