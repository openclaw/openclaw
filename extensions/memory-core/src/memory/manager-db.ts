// Memory Core plugin module implements manager db behavior.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureDir,
<<<<<<< HEAD
  loadSqliteVecExtension,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  ensureOpenClawAgentDatabaseSchema,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
=======
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  acquireMemoryReindexSwapReadLock,
  acquireMemoryReindexLock,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  tryAcquireMemoryReindexLock,
  type MemoryReindexLockHandle,
} from "./manager-reindex-lock.js";

<<<<<<< HEAD
const MEMORY_REINDEX_SCHEMA = "memory_reindex";
const MEMORY_INDEX_STATE_ID = 1;
const MEMORY_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const MEMORY_REINDEX_ENTRY_SUFFIXES = ["-wal", "-shm", "-journal", ""] as const;
const MEMORY_REINDEX_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMORY_REINDEX_ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;

function resolveMemoryReindexBaseName(
  databaseBaseName: string,
  entryName: string,
): string | undefined {
  for (const suffix of MEMORY_REINDEX_ENTRY_SUFFIXES) {
=======
// Hard-killed safe reindexes cannot run JS cleanup on their temp DB triplet.
// Startup only removes old sibling triplets so another live process can still
// own a young temp DB without losing its in-flight rebuild.
const reindexTempFileWithoutLockMinAgeMs = 24 * 60 * 60_000;
const reindexTempUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const memoryIndexFileSuffixes = ["", "-wal", "-shm", "-journal"] as const;
const reindexTempEntrySuffixes = ["-wal", "-shm", "-journal", ""] as const;
const liveDatabaseSwapLocks = new WeakMap<DatabaseSync, MemoryReindexLockHandle>();

function resolveReindexTempBaseName(dbBaseName: string, entryName: string): string | undefined {
  for (const suffix of reindexTempEntrySuffixes) {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    if (!entryName.endsWith(suffix)) {
      continue;
    }
    const baseName = entryName.slice(0, entryName.length - suffix.length);
<<<<<<< HEAD
    const prefix = `${databaseBaseName}.memory-reindex-`;
    if (
      baseName.startsWith(prefix) &&
      MEMORY_REINDEX_UUID_PATTERN.test(baseName.slice(prefix.length))
    ) {
=======
    const tempPrefix = `${dbBaseName}.tmp-`;
    if (!baseName.startsWith(tempPrefix)) {
      continue;
    }
    const uuid = baseName.slice(tempPrefix.length);
    if (reindexTempUuidPattern.test(uuid)) {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      return baseName;
    }
  }
  return undefined;
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

<<<<<<< HEAD
function tableExists(db: DatabaseSync, schema: string, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

function readTableSql(db: DatabaseSync, schema: string, tableName: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" && row.sql.trim() ? row.sql : null;
}

function hasSqliteVecExtension(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT vec_version() AS version").get() as
      | { version?: unknown }
      | undefined;
    return typeof row?.version === "string" && row.version.trim().length > 0;
  } catch {
    return false;
  }
}

export function readMemoryDatabaseRevision(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT revision FROM memory_index_state WHERE id = ?")
    .get(MEMORY_INDEX_STATE_ID) as { revision?: unknown } | undefined;
  if (typeof row?.revision !== "number" || !Number.isSafeInteger(row.revision)) {
    throw new Error("Memory index revision is missing or invalid");
  }
  return row.revision;
}

function replaceVirtualTable(params: {
  db: DatabaseSync;
  tableName: "memory_index_chunks_fts" | "memory_index_chunks_vec";
  columns: string;
  ignoreDropErrorWhenSourceMissing?: boolean;
}): void {
  const { db, tableName, columns } = params;
  const createSql = readTableSql(db, MEMORY_REINDEX_SCHEMA, tableName);
  if (!createSql) {
    try {
      db.exec(`DROP TABLE IF EXISTS main.${tableName}`);
    } catch (err) {
      if (!params.ignoreDropErrorWhenSourceMissing) {
        throw err;
      }
    }
    return;
  }
  db.exec(`DROP TABLE IF EXISTS main.${tableName}`);
  db.exec(createSql);
  db.exec(
    `INSERT INTO main.${tableName} (${columns}) ` +
      `SELECT ${columns} FROM ${MEMORY_REINDEX_SCHEMA}.${tableName}`,
  );
}

/** Publish a completed shadow memory index without replacing the shared agent database file. */
export async function publishMemoryDatabaseTables(params: {
  targetDb: DatabaseSync;
  sourcePath: string;
  metaKey: string;
  expectedRevision: number;
  vectorExtensionPath?: string;
}): Promise<void> {
  params.targetDb.prepare(`ATTACH DATABASE ? AS ${MEMORY_REINDEX_SCHEMA}`).run(params.sourcePath);
  try {
    if (
      tableExists(params.targetDb, MEMORY_REINDEX_SCHEMA, "memory_index_chunks_vec") &&
      !hasSqliteVecExtension(params.targetDb)
    ) {
      const loaded = await loadSqliteVecExtension({
        db: params.targetDb,
        extensionPath: params.vectorExtensionPath,
      });
      if (!loaded.ok) {
        throw new Error(
          `Failed to load sqlite-vec before publishing the full memory reindex: ` +
            (loaded.error ?? "unknown sqlite-vec load error"),
        );
      }
    }
    runSqliteImmediateTransactionSync(params.targetDb, () => {
      const liveRevision = readMemoryDatabaseRevision(params.targetDb);
      if (liveRevision !== params.expectedRevision) {
        throw new Error(
          `Memory index changed while full reindex was building ` +
            `(expected revision ${params.expectedRevision}, found ${liveRevision}); retry the full reindex.`,
        );
      }
      params.targetDb
        .prepare("DELETE FROM main.memory_index_meta WHERE key = ?")
        .run(params.metaKey);
      params.targetDb
        .prepare(
          `INSERT INTO main.memory_index_meta (key, value)
           SELECT key, value FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_meta WHERE key = ?`,
        )
        .run(params.metaKey);

      params.targetDb.exec(`
        DELETE FROM main.memory_index_sources;
        INSERT INTO main.memory_index_sources (path, source, hash, mtime, size)
        SELECT path, source, hash, mtime, size FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_sources;

        DELETE FROM main.memory_index_chunks;
        INSERT INTO main.memory_index_chunks (
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        )
        SELECT
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_chunks;
      `);

      if (tableExists(params.targetDb, MEMORY_REINDEX_SCHEMA, "memory_embedding_cache")) {
        params.targetDb.exec(`
          DELETE FROM main.memory_embedding_cache;
          INSERT INTO main.memory_embedding_cache (
            provider, model, provider_key, hash, embedding, dims, updated_at
          )
          SELECT provider, model, provider_key, hash, embedding, dims, updated_at
          FROM ${MEMORY_REINDEX_SCHEMA}.memory_embedding_cache;
        `);
      }

      replaceVirtualTable({
        db: params.targetDb,
        tableName: "memory_index_chunks_fts",
        columns: "text, id, path, source, model, start_line, end_line",
      });
      replaceVirtualTable({
        db: params.targetDb,
        tableName: "memory_index_chunks_vec",
        columns: "id, embedding",
        // A vector-disabled connection may not have sqlite-vec loaded and cannot
        // drop an old virtual table. Missing vector metadata forces a strict
        // rebuild before that table can be queried again.
        ignoreDropErrorWhenSourceMissing: true,
      });
    });
  } finally {
    params.targetDb.exec(`DETACH DATABASE ${MEMORY_REINDEX_SCHEMA}`);
  }
}

/** Remove one closed shadow memory database and its journal-mode sidecars. */
export function removeMemoryDatabaseFiles(dbPath: string): void {
  for (const suffix of MEMORY_DATABASE_FILE_SUFFIXES) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** Remove crash-left shadow databases only when no full reindex is active. */
export function cleanupAgedMemoryReindexTempFiles(dbPath: string, nowMs = Date.now()): void {
  if (!isRegularFile(dbPath)) {
    return;
  }

=======
export function cleanupAgedMemoryReindexTempFiles(dbPath: string, nowMs = Date.now()): void {
  // A missing live database can be the brief Windows swap window. Never delete
  // the only complete temp candidate while the canonical path is absent.
  if (!isRegularFile(dbPath)) {
    return;
  }
  const dir = path.dirname(dbPath);
  const dbBaseName = path.basename(dbPath);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  let reindexLock: MemoryReindexLockHandle | undefined;
  try {
    reindexLock = tryAcquireMemoryReindexLock(dbPath);
  } catch {
<<<<<<< HEAD
=======
    // Startup cleanup is best effort; the actual reindex path acquires the same
    // lock strictly before it creates or publishes a replacement database.
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    return;
  }
  if (!reindexLock) {
    return;
  }
<<<<<<< HEAD

  try {
    const dir = path.dirname(dbPath);
    const databaseBaseName = path.basename(dbPath);
    const shadowBaseNames = new Set<string>();
=======
  try {
    const tempBaseNames = new Set<string>();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
<<<<<<< HEAD

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
<<<<<<< HEAD
      const shadowBaseName = resolveMemoryReindexBaseName(databaseBaseName, entry.name);
      if (shadowBaseName) {
        shadowBaseNames.add(shadowBaseName);
      }
    }

    for (const shadowBaseName of shadowBaseNames) {
      const filePaths = MEMORY_DATABASE_FILE_SUFFIXES.map((suffix) =>
        path.join(dir, `${shadowBaseName}${suffix}`),
=======
      const tempBaseName = resolveReindexTempBaseName(dbBaseName, entry.name);
      if (tempBaseName) {
        tempBaseNames.add(tempBaseName);
      }
    }

    for (const tempBaseName of tempBaseNames) {
      if (!isRegularFile(dbPath)) {
        return;
      }
      const filePaths = memoryIndexFileSuffixes.map((suffix) =>
        path.join(dir, `${tempBaseName}${suffix}`),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      );
      const stats: fs.Stats[] = [];
      let hasUnknownFileState = false;
      for (const filePath of filePaths) {
        try {
          stats.push(fs.statSync(filePath));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            hasUnknownFileState = true;
            break;
          }
        }
      }
      if (hasUnknownFileState || stats.length === 0) {
        continue;
      }
<<<<<<< HEAD
      if (
        nowMs - Math.max(...stats.map((stat) => stat.mtimeMs)) <
        MEMORY_REINDEX_ORPHAN_MIN_AGE_MS
      ) {
=======
      const newestMtimeMs = Math.max(...stats.map((stat) => stat.mtimeMs));
      if (nowMs - newestMtimeMs < reindexTempFileWithoutLockMinAgeMs) {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        continue;
      }
      for (const filePath of filePaths) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {}
      }
    }
  } finally {
    try {
      reindexLock.release();
    } catch {}
  }
}

<<<<<<< HEAD
export function openMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
  agentId?: string,
): DatabaseSync {
  ensureDir(path.dirname(dbPath));
=======
function openConfiguredMemoryDatabaseAtPath(dbPath: string, allowExtension: boolean): DatabaseSync {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { allowExtension });
  try {
    configureMemorySqliteWalMaintenance(db, {
      busyTimeoutMs: 5000,
      databasePath: dbPath,
    });
<<<<<<< HEAD
    if (agentId) {
      ensureOpenClawAgentDatabaseSchema(db, { agentId, path: dbPath, register: true });
    }
    return db;
  } catch (err) {
    try {
      closeMemorySqliteWalMaintenance(db);
=======
    return db;
  } catch (err) {
    try {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      db.close();
    } catch {}
    throw err;
  }
}

<<<<<<< HEAD
export function closeMemoryDatabase(db: DatabaseSync): void {
  closeMemorySqliteWalMaintenance(db);
  db.close();
=======
type ExistingMemoryDatabaseOpenResult =
  | { status: "opened"; db: DatabaseSync }
  | { status: "missing"; cause: unknown };

function isMemoryDatabaseMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("unable to open database file") || message.includes("SQLITE_CANTOPEN");
}

function tryOpenExistingMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
): ExistingMemoryDatabaseOpenResult {
  const { DatabaseSync } = requireNodeSqlite();
  let probe: DatabaseSync;
  try {
    probe = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    if (isMemoryDatabaseMissingError(err)) {
      return { status: "missing", cause: err };
    }
    throw err;
  }

  // Keep the read-only handle open until the read-write handle exists. On
  // Windows this prevents a safe reindex from creating an absent-path window.
  let db: DatabaseSync;
  try {
    db = openConfiguredMemoryDatabaseAtPath(dbPath, allowExtension);
  } catch (err) {
    try {
      probe.close();
    } catch {}
    throw err;
  }
  try {
    probe.close();
  } catch (err) {
    closeMemoryDatabase(db);
    throw err;
  }
  return { status: "opened", db };
}

export function openMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
  allowCreate = true,
): DatabaseSync {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  cleanupAgedMemoryReindexTempFiles(dbPath);
  const swapReadLock = acquireMemoryReindexSwapReadLock(dbPath);
  try {
    const existing = tryOpenExistingMemoryDatabaseAtPath(dbPath, allowExtension);
    if (existing.status === "opened") {
      liveDatabaseSwapLocks.set(existing.db, swapReadLock);
      return existing.db;
    }
    if (!allowCreate) {
      throw new Error(
        `Memory database not found at ${dbPath}; refusing to auto-create an empty database during an index swap window.`,
        { cause: existing.cause },
      );
    }

    // A missing canonical path can be an initial create or the Windows swap
    // window. Only the safe-reindex owner may create or publish during that gap.
    const openLock = acquireMemoryReindexLock(dbPath);
    let db: DatabaseSync;
    try {
      const lockedExisting = tryOpenExistingMemoryDatabaseAtPath(dbPath, allowExtension);
      db =
        lockedExisting.status === "opened"
          ? lockedExisting.db
          : openConfiguredMemoryDatabaseAtPath(dbPath, allowExtension);
    } catch (err) {
      try {
        openLock.release();
      } catch {}
      throw err;
    }
    try {
      openLock.release();
    } catch (err) {
      closeMemoryDatabase(db);
      throw err;
    }
    liveDatabaseSwapLocks.set(db, swapReadLock);
    return db;
  } catch (err) {
    try {
      swapReadLock.release();
    } catch {}
    throw err;
  }
}

export function openMemoryReindexTempDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
): DatabaseSync {
  ensureDir(path.dirname(dbPath));
  return openConfiguredMemoryDatabaseAtPath(dbPath, allowExtension);
}

export function closeMemoryDatabase(db: DatabaseSync): void {
  closeMemorySqliteWalMaintenance(db);
  db.close();
  releaseMemoryDatabaseSwapLock(db);
}

export function releaseMemoryDatabaseSwapLock(db: DatabaseSync): void {
  const swapLock = liveDatabaseSwapLocks.get(db);
  if (swapLock) {
    liveDatabaseSwapLocks.delete(db);
    swapLock.release();
  }
}

export function restoreMemoryDatabaseSwapLock(db: DatabaseSync, dbPath: string): void {
  if (!liveDatabaseSwapLocks.has(db)) {
    liveDatabaseSwapLocks.set(db, acquireMemoryReindexSwapReadLock(dbPath));
  }
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}
