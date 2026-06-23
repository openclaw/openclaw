// Memory Core doctor contract migrates shipped workspace dreaming state.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveMemoryDreamingWorkspaces } from "openclaw/plugin-sdk/memory-core-host-status";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import {
  ensureOpenClawAgentDatabaseSchema,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  DAILY_INGESTION_STATE_RELATIVE_PATH,
  SESSION_INGESTION_STATE_RELATIVE_PATH,
  normalizeDailyIngestionState,
  normalizeSessionIngestionState,
} from "./src/dreaming-phases.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  SESSION_SEEN_HASHES_PER_CHUNK,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  configureMemoryCoreDreamingState,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./src/dreaming-state.js";
import {
  SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH,
  SHORT_TERM_STORE_RELATIVE_PATH,
  normalizeShortTermPhaseSignalStore,
  normalizeShortTermRecallStore,
} from "./src/short-term-promotion.js";

type LegacySource = {
  workspaceDir: string;
  label: string;
  filePath: string;
};

type LegacyMemorySidecarSource = {
  agentId: string;
  legacyPath: string;
  agentDatabasePath: string;
};

const LEGACY_MEMORY_SIDECAR_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const LEGACY_MEMORY_SIDECAR_SCHEMA = "legacy_memory_sidecar";
const LEGACY_MEMORY_VECTOR_TABLE = "chunks_vec";
const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

const LEGACY_MEMORY_SOURCE_COLUMNS = ["path", "source", "hash", "mtime", "size"] as const;
const LEGACY_MEMORY_CHUNK_COLUMNS = [
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
  vectorEntries: number;
  vectorEntriesImported: boolean;
};

function tableExists(db: DatabaseSync, schema: string, tableName: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE name = ?`).get(tableName));
}

function tableColumns(db: DatabaseSync, tableName: string, schema = "main"): Set<string> {
  const rows = db.prepare(`PRAGMA ${schema}.table_info(${tableName})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

function tableHasColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
  schema = "main",
): boolean {
  const columns = tableColumns(db, tableName, schema);
  return expected.every((column) => columns.has(column));
}

function tableHasExactColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
  schema = "main",
): boolean {
  const columns = tableColumns(db, tableName, schema);
  return columns.size === expected.length && expected.every((column) => columns.has(column));
}

function hasLegacyMemoryIndexTables(db: DatabaseSync, schema = "main"): boolean {
  return (
    tableHasExactColumns(db, "meta", ["key", "value"], schema) &&
    tableHasExactColumns(db, "files", LEGACY_MEMORY_SOURCE_COLUMNS, schema) &&
    tableHasExactColumns(db, "chunks", LEGACY_MEMORY_CHUNK_COLUMNS, schema)
  );
}

function hasLegacyEmbeddingCacheTable(db: DatabaseSync, schema = "main"): boolean {
  return tableHasExactColumns(db, "embedding_cache", LEGACY_MEMORY_CACHE_COLUMNS, schema);
}

function hasLegacyVectorTable(db: DatabaseSync, schema = "main"): boolean {
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
): Pick<LegacyMemorySidecarImportResult, "sources" | "chunks" | "cacheEntries" | "vectorEntries"> {
  return {
    sources: tableRowCount(db, schema, "files"),
    chunks: tableRowCount(db, schema, "chunks"),
    cacheEntries: hasLegacyEmbeddingCacheTable(db, schema)
      ? tableRowCount(db, schema, "embedding_cache")
      : 0,
    vectorEntries: hasLegacyVectorTable(db, schema)
      ? tableRowCount(db, schema, LEGACY_MEMORY_VECTOR_TABLE)
      : 0,
  };
}

function assertLegacyRowsCopied(db: DatabaseSync, query: string, tableName: string): void {
  const row = db.prepare(query).get() as { missing?: unknown } | undefined;
  if (Number(row?.missing ?? 0) > 0) {
    throw new Error(`legacy memory ${tableName} rows conflict with canonical memory index rows`);
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
    if (Number.isSafeInteger(parsed.vectorDims) && Number(parsed.vectorDims) > 0) {
      return Number(parsed.vectorDims);
    }
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
  const metaDimensions = readMemoryIndexMetaVectorDimensions(db, schema, "meta");
  if (metaDimensions) {
    return metaDimensions;
  }
  const tableSqlDimensions = readVectorTableSqlDimensions(db, schema, LEGACY_MEMORY_VECTOR_TABLE);
  if (tableSqlDimensions) {
    return tableSqlDimensions;
  }
  const row = db
    .prepare(
      `SELECT length(embedding) AS bytes FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} WHERE embedding IS NOT NULL LIMIT 1`,
    )
    .get() as { bytes?: unknown } | undefined;
  const bytes = Number(row?.bytes ?? 0);
  if (Number.isSafeInteger(bytes) && bytes > 0 && bytes % Float32Array.BYTES_PER_ELEMENT === 0) {
    return bytes / Float32Array.BYTES_PER_ELEMENT;
  }
  return undefined;
}

function readCanonicalVectorDimensions(db: DatabaseSync): number | undefined {
  return (
    readVectorTableSqlDimensions(db, "main", MEMORY_INDEX_VECTOR_TABLE) ??
    readMemoryIndexMetaVectorDimensions(db, "main", MEMORY_INDEX_META_TABLE)
  );
}

function ensureCanonicalVectorTableForLegacyRows(db: DatabaseSync, schema: string): void {
  if (
    !hasLegacyVectorTable(db, schema) ||
    tableRowCount(db, schema, LEGACY_MEMORY_VECTOR_TABLE) === 0
  ) {
    return;
  }
  const dimensions = readLegacyVectorDimensions(db, schema);
  if (!Number.isSafeInteger(dimensions) || Number(dimensions) <= 0) {
    throw new Error("legacy memory chunks_vec rows require vector dimensions before import");
  }
  if (tableExists(db, "main", MEMORY_INDEX_VECTOR_TABLE)) {
    const canonicalDimensions = readCanonicalVectorDimensions(db);
    if (!Number.isSafeInteger(canonicalDimensions) || Number(canonicalDimensions) <= 0) {
      throw new Error(
        "canonical memory chunks_vec table requires vector dimensions before legacy import",
      );
    }
    if (Number(canonicalDimensions) !== Number(dimensions)) {
      throw new Error(
        `legacy memory chunks_vec dimensions ${Number(dimensions)} do not match canonical memory chunks_vec dimensions ${Number(canonicalDimensions)}`,
      );
    }
    return;
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS main.${MEMORY_INDEX_VECTOR_TABLE} USING vec0(\n` +
      `  id TEXT PRIMARY KEY,\n` +
      `  embedding FLOAT[${Number(dimensions)}]\n` +
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
  db.exec(`
    INSERT OR IGNORE INTO main.${MEMORY_INDEX_VECTOR_TABLE} (id, embedding)
    SELECT legacy.id, legacy.embedding
    FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
    JOIN main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk ON chunk.id = legacy.id;
  `);
  assertLegacyRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
     JOIN main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk ON chunk.id = legacy.id
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_VECTOR_TABLE} AS canonical
       WHERE canonical.id = legacy.id
     )`,
    LEGACY_MEMORY_VECTOR_TABLE,
  );
}

function copyLegacyMemoryFtsRows(db: DatabaseSync, schema: string): void {
  if (!tableExists(db, "main", MEMORY_INDEX_FTS_TABLE)) {
    return;
  }
  db.exec(`
    INSERT INTO main.${MEMORY_INDEX_FTS_TABLE} (
      text, id, path, source, model, start_line, end_line
    )
    SELECT legacy.text, legacy.id, legacy.path, legacy.source, legacy.model,
           legacy.start_line, legacy.end_line
    FROM ${schema}.chunks AS legacy
    JOIN main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk ON chunk.id = legacy.id
    WHERE NOT EXISTS (
      SELECT 1 FROM main.${MEMORY_INDEX_FTS_TABLE} AS canonical
      WHERE canonical.id = legacy.id
    );
  `);
  assertLegacyRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.chunks AS legacy
     JOIN main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk ON chunk.id = legacy.id
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_FTS_TABLE} AS canonical
       WHERE canonical.id = legacy.id
     )`,
    "fts",
  );
}

function copyLegacyMemoryIndexRows(
  db: DatabaseSync,
  schema: string,
  options: { copyVectorRows: boolean },
): void {
  db.exec(`
    INSERT OR IGNORE INTO main.${MEMORY_INDEX_META_TABLE} (key, value)
    SELECT key, value FROM ${schema}.meta;

    INSERT OR IGNORE INTO main.${MEMORY_INDEX_SOURCES_TABLE} (path, source, hash, mtime, size)
    SELECT path, source, hash, mtime, size FROM ${schema}.files;

    INSERT OR IGNORE INTO main.${MEMORY_INDEX_CHUNKS_TABLE} (
      id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
    )
    SELECT id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
    FROM ${schema}.chunks;
  `);
  assertLegacyRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.meta AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_META_TABLE} AS canonical
       WHERE canonical.key = legacy.key AND canonical.value IS legacy.value
     )`,
    "meta",
  );
  assertLegacyRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.files AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_SOURCES_TABLE} AS canonical
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
     FROM ${schema}.chunks AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS canonical
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
  copyLegacyMemoryFtsRows(db, schema);
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
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
      INSERT OR IGNORE INTO main.${MEMORY_EMBEDDING_CACHE_TABLE} (
        provider, model, provider_key, hash, embedding, dims, updated_at
      )
      SELECT provider, model, provider_key, hash, embedding, dims, updated_at
      FROM ${schema}.embedding_cache;
    `);
    assertLegacyRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM ${schema}.embedding_cache AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_EMBEDDING_CACHE_TABLE} AS canonical
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
  }
}

function importLegacyMemorySidecarIndex(params: {
  db: DatabaseSync;
  legacySidecarDatabasePath: string | undefined;
  copyVectorRows: boolean;
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
    const counts = readLegacySidecarCounts(params.db, LEGACY_MEMORY_SIDECAR_SCHEMA);
    params.db.exec("SAVEPOINT import_legacy_sidecar_memory_index");
    try {
      copyLegacyMemoryIndexRows(params.db, LEGACY_MEMORY_SIDECAR_SCHEMA, {
        copyVectorRows: params.copyVectorRows,
      });
      params.db.exec("RELEASE import_legacy_sidecar_memory_index");
      return {
        imported: true,
        ...counts,
        vectorEntriesImported: counts.vectorEntries === 0 || params.copyVectorRows,
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

function resolveConfiguredAgentIds(config: unknown): string[] {
  const cfg = config as { agents?: { list?: unknown } };
  const ids = new Set<string>();
  if (Array.isArray(cfg.agents?.list)) {
    for (const entry of cfg.agents.list) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const id = (entry as { id?: unknown }).id;
      ids.add(normalizeAgentId(typeof id === "string" ? id : undefined));
    }
  }
  if (ids.size === 0) {
    ids.add(normalizeAgentId(undefined));
  }
  return [...ids];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readMemorySearchVectorExtensionPath(config: unknown, agentId: string): string | undefined {
  const agents = asRecord(asRecord(config)?.agents);
  const defaultsMemorySearch = asRecord(asRecord(agents?.defaults)?.memorySearch);
  const defaultVector = asRecord(asRecord(defaultsMemorySearch?.store)?.vector);
  const entries = Array.isArray(agents?.list) ? agents.list : [];
  const agentMemorySearch = entries
    .map(asRecord)
    .find(
      (entry) => normalizeAgentId(typeof entry?.id === "string" ? entry.id : undefined) === agentId,
    )?.memorySearch;
  const agentVector = asRecord(asRecord(asRecord(agentMemorySearch)?.store)?.vector);
  const raw = agentVector?.extensionPath ?? defaultVector?.extensionPath;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

async function collectLegacyMemorySidecarSources(params: {
  config: unknown;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): Promise<LegacyMemorySidecarSource[]> {
  const agentIds = new Set(resolveConfiguredAgentIds(params.config));
  const legacyDir = path.join(params.stateDir, "memory");
  try {
    const entries = await fs.readdir(legacyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        agentIds.add(normalizeAgentId(entry.name.slice(0, -".sqlite".length)));
      }
    }
  } catch {}

  const migrationEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const sources: LegacyMemorySidecarSource[] = [];
  for (const agentId of agentIds) {
    const legacyPath = path.join(legacyDir, `${agentId}.sqlite`);
    if (!(await fileExists(legacyPath))) {
      continue;
    }
    sources.push({
      agentId,
      legacyPath,
      agentDatabasePath: resolveOpenClawAgentSqlitePath({ agentId, env: migrationEnv }),
    });
  }
  return sources;
}

async function archiveLegacyMemorySidecar(params: {
  source: LegacyMemorySidecarSource;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const existingSources = (
    await Promise.all(
      LEGACY_MEMORY_SIDECAR_SUFFIXES.map(async (suffix) => {
        const filePath = `${params.source.legacyPath}${suffix}`;
        return (await fileExists(filePath)) ? filePath : null;
      }),
    )
  ).filter((filePath): filePath is string => filePath !== null);
  if (existingSources.length === 0) {
    return;
  }
  const existingArchives = (
    await Promise.all(
      existingSources.map(async (sourcePath) => {
        const archivedPath = `${sourcePath}.migrated`;
        return (await fileExists(archivedPath)) ? archivedPath : null;
      }),
    )
  ).filter((filePath): filePath is string => filePath !== null);
  if (existingArchives.length > 0) {
    params.warnings.push(
      `Left migrated Memory Core legacy memory index sidecar in place because ${existingArchives[0]} already exists`,
    );
    return;
  }
  const renamed: Array<{ sourcePath: string; archivedPath: string }> = [];
  for (const sourcePath of existingSources) {
    const archivedPath = `${sourcePath}.migrated`;
    try {
      await fs.rename(sourcePath, archivedPath);
      renamed.push({ sourcePath, archivedPath });
    } catch (err) {
      for (const entry of renamed.toReversed()) {
        try {
          if ((await fileExists(entry.archivedPath)) && !(await fileExists(entry.sourcePath))) {
            await fs.rename(entry.archivedPath, entry.sourcePath);
          }
        } catch (rollbackErr) {
          params.warnings.push(
            `Failed restoring Memory Core legacy memory index sidecar ${entry.archivedPath}: ${String(rollbackErr)}`,
          );
        }
      }
      params.warnings.push(
        `Failed archiving Memory Core legacy memory index sidecar ${sourcePath}: ${String(err)}; restored ${renamed.length} already archived file(s)`,
      );
      return;
    }
  }
  params.changes.push(
    `Archived Memory Core legacy memory index sidecar -> ${params.source.legacyPath}.migrated`,
  );
}

async function migrateLegacyMemorySidecarSource(params: {
  source: LegacyMemorySidecarSource;
  config: unknown;
  env: NodeJS.ProcessEnv;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  await fs.mkdir(path.dirname(params.source.agentDatabasePath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(params.source.agentDatabasePath, { allowExtension: true });
  try {
    const migrationEnv = {
      ...params.env,
      OPENCLAW_STATE_DIR: path.dirname(path.dirname(params.source.legacyPath)),
    };
    ensureOpenClawAgentDatabaseSchema(db, {
      agentId: params.source.agentId,
      env: migrationEnv,
      path: params.source.agentDatabasePath,
      register: true,
    });
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    const vectorExtensionPath = readMemorySearchVectorExtensionPath(
      params.config,
      params.source.agentId,
    );
    const loadedVector = await loadSqliteVecExtension({
      db,
      extensionPath: vectorExtensionPath
        ? resolveUserPath(vectorExtensionPath, params.env)
        : undefined,
    });
    let result: LegacyMemorySidecarImportResult;
    try {
      result = importLegacyMemorySidecarIndex({
        db,
        legacySidecarDatabasePath: params.source.legacyPath,
        copyVectorRows: loadedVector.ok,
      });
    } catch (err) {
      params.warnings.push(
        `Skipped Memory Core legacy memory index import for agent ${params.source.agentId} because legacy rows could not be imported: ${String(err)}`,
      );
      return;
    }
    if (result.reason === "legacy-schema-missing") {
      params.warnings.push(
        `Skipped Memory Core legacy memory index import for agent ${params.source.agentId} because the sidecar schema is not a legacy memory index`,
      );
      return;
    }
    if (!result.imported) {
      return;
    }
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    params.changes.push(
      `Migrated Memory Core legacy memory index for agent ${params.source.agentId} -> per-agent SQLite (${result.sources} source(s), ${result.chunks} chunk(s), ${result.cacheEntries} cache row(s))`,
    );
    if (!result.vectorEntriesImported) {
      params.warnings.push(
        `Left Memory Core legacy memory index sidecar in place for agent ${params.source.agentId} because ${result.vectorEntries} vector row(s) still require sqlite-vec: ${loadedVector.error ?? "unknown sqlite-vec load error"}`,
      );
      return;
    }
    await archiveLegacyMemorySidecar(params);
  } finally {
    db.close();
  }
}

function resolveConfiguredWorkspaces(config: unknown, env: NodeJS.ProcessEnv): string[] {
  return resolveMemoryDreamingWorkspaces(
    config as Parameters<typeof resolveMemoryDreamingWorkspaces>[0],
    { env },
  ).map((entry) => entry.workspaceDir);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function archiveLegacySource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated Memory Core ${params.label} source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived Memory Core ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(
      `Failed archiving Memory Core ${params.label} legacy source: ${String(err)}`,
    );
  }
}

async function collectLegacySources(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<LegacySource[]> {
  const sources: LegacySource[] = [];
  for (const workspaceDir of resolveConfiguredWorkspaces(config, env)) {
    const candidates = [
      { label: "daily ingestion", relativePath: DAILY_INGESTION_STATE_RELATIVE_PATH },
      { label: "session ingestion", relativePath: SESSION_INGESTION_STATE_RELATIVE_PATH },
      { label: "short-term recall", relativePath: SHORT_TERM_STORE_RELATIVE_PATH },
      { label: "phase signals", relativePath: SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH },
    ];
    for (const candidate of candidates) {
      const filePath = path.join(workspaceDir, candidate.relativePath);
      if (await fileExists(filePath)) {
        sources.push({ workspaceDir, label: candidate.label, filePath });
      }
    }
  }
  return sources;
}

async function workspaceHasRows(namespace: string, workspaceDir: string): Promise<boolean> {
  return (await readMemoryCoreWorkspaceEntries({ namespace, workspaceDir })).length > 0;
}

async function migrateDailyIngestion(source: LegacySource): Promise<number> {
  const state = normalizeDailyIngestionState(await readJsonFile(source.filePath));
  await writeMemoryCoreWorkspaceEntries({
    namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
    workspaceDir: source.workspaceDir,
    entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
  });
  return Object.keys(state.files).length;
}

async function migrateSessionIngestion(source: LegacySource): Promise<number> {
  const state = normalizeSessionIngestionState(await readJsonFile(source.filePath));
  const seenEntries = Object.entries(state.seenMessages).flatMap(([scope, hashes]) =>
    Array.from(
      { length: Math.ceil(hashes.length / SESSION_SEEN_HASHES_PER_CHUNK) },
      (_, index) => ({
        key: `${scope}:${index}`,
        value: {
          scope,
          index,
          hashes: hashes.slice(
            index * SESSION_SEEN_HASHES_PER_CHUNK,
            (index + 1) * SESSION_SEEN_HASHES_PER_CHUNK,
          ),
        },
      }),
    ),
  );
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: seenEntries,
    }),
  ]);
  return Object.keys(state.files).length + Object.keys(state.seenMessages).length;
}

async function migrateShortTermRecall(source: LegacySource): Promise<number> {
  const nowIso = new Date().toISOString();
  const state = normalizeShortTermRecallStore(await readJsonFile(source.filePath), nowIso);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.workspaceDir,
      key: "recall",
      value: { updatedAt: state.updatedAt },
    }),
  ]);
  return Object.keys(state.entries).length;
}

async function migratePhaseSignals(source: LegacySource): Promise<number> {
  const nowIso = new Date().toISOString();
  const state = normalizeShortTermPhaseSignalStore(await readJsonFile(source.filePath), nowIso);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.workspaceDir,
      key: "phase",
      value: { updatedAt: state.updatedAt },
    }),
  ]);
  return Object.keys(state.entries).length;
}

function targetNamespacesForSource(label: string): string[] {
  if (label === "daily ingestion") {
    return [DREAMING_DAILY_INGESTION_NAMESPACE];
  }
  if (label === "session ingestion") {
    return [DREAMING_SESSION_INGESTION_FILES_NAMESPACE, DREAMING_SESSION_INGESTION_SEEN_NAMESPACE];
  }
  if (label === "short-term recall") {
    return [SHORT_TERM_RECALL_NAMESPACE];
  }
  return [SHORT_TERM_PHASE_SIGNAL_NAMESPACE];
}

async function migrateSource(source: LegacySource): Promise<number> {
  if (source.label === "daily ingestion") {
    return await migrateDailyIngestion(source);
  }
  if (source.label === "session ingestion") {
    return await migrateSessionIngestion(source);
  }
  if (source.label === "short-term recall") {
    return await migrateShortTermRecall(source);
  }
  return await migratePhaseSignals(source);
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "memory-core-dreams-json-to-sqlite",
    label: "Memory Core dreaming state",
    async detectLegacyState(params) {
      configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
      const sources = await collectLegacySources(params.config, params.env);
      if (sources.length === 0) {
        return null;
      }
      return {
        preview: sources.map(
          (source) => `- Memory Core ${source.label}: ${source.filePath} -> SQLite plugin state`,
        ),
      };
    },
    async migrateLegacyState(params) {
      configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const source of await collectLegacySources(params.config, params.env)) {
        const targetHasRows = (
          await Promise.all(
            targetNamespacesForSource(source.label).map((namespace) =>
              workspaceHasRows(namespace, source.workspaceDir),
            ),
          )
        ).some(Boolean);
        if (targetHasRows) {
          warnings.push(
            `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because SQLite rows already exist; left legacy source in place`,
          );
          continue;
        }
        let imported: number;
        try {
          imported = await migrateSource(source);
        } catch (err) {
          warnings.push(
            `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because the legacy source could not be imported: ${String(err)}`,
          );
          continue;
        }
        changes.push(
          `Migrated Memory Core ${source.label} -> SQLite plugin state (${imported} row(s))`,
        );
        await archiveLegacySource({
          filePath: source.filePath,
          label: source.label,
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
  {
    id: "memory-core-legacy-sidecar-index-to-agent-sqlite",
    label: "Memory Core legacy memory index sidecar",
    async detectLegacyState(params) {
      const sources = await collectLegacyMemorySidecarSources({
        config: params.config,
        env: params.env,
        stateDir: params.stateDir,
      });
      if (sources.length === 0) {
        return null;
      }
      return {
        preview: sources.map(
          (source) =>
            `- Memory Core legacy memory index: ${source.legacyPath} -> ${source.agentDatabasePath}`,
        ),
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const source of await collectLegacyMemorySidecarSources({
        config: params.config,
        env: params.env,
        stateDir: params.stateDir,
      })) {
        try {
          await migrateLegacyMemorySidecarSource({
            source,
            config: params.config,
            env: params.env,
            changes,
            warnings,
          });
        } catch (err) {
          warnings.push(
            `Skipped Memory Core legacy memory index import for agent ${source.agentId} because the sidecar could not be imported: ${String(err)}`,
          );
        }
      }
      return { changes, warnings };
    },
  },
];
