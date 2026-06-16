// Memory Core plugin module implements manager db behavior.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureDir,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  acquireMemoryReindexSwapReadLock,
  acquireMemoryReindexLock,
  tryAcquireMemoryReindexLock,
  type MemoryReindexLockHandle,
} from "./manager-reindex-lock.js";

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
    if (!entryName.endsWith(suffix)) {
      continue;
    }
    const baseName = entryName.slice(0, entryName.length - suffix.length);
    const tempPrefix = `${dbBaseName}.tmp-`;
    if (!baseName.startsWith(tempPrefix)) {
      continue;
    }
    const uuid = baseName.slice(tempPrefix.length);
    if (reindexTempUuidPattern.test(uuid)) {
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

export function cleanupAgedMemoryReindexTempFiles(dbPath: string, nowMs = Date.now()): void {
  // A missing live database can be the brief Windows swap window. Never delete
  // the only complete temp candidate while the canonical path is absent.
  if (!isRegularFile(dbPath)) {
    return;
  }
  const dir = path.dirname(dbPath);
  const dbBaseName = path.basename(dbPath);
  let reindexLock: MemoryReindexLockHandle | undefined;
  try {
    reindexLock = tryAcquireMemoryReindexLock(dbPath);
  } catch {
    // Startup cleanup is best effort; the actual reindex path acquires the same
    // lock strictly before it creates or publishes a replacement database.
    return;
  }
  if (!reindexLock) {
    return;
  }
  try {
    const tempBaseNames = new Set<string>();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
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
      const newestMtimeMs = Math.max(...stats.map((stat) => stat.mtimeMs));
      if (nowMs - newestMtimeMs < reindexTempFileWithoutLockMinAgeMs) {
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

function openConfiguredMemoryDatabaseAtPath(dbPath: string, allowExtension: boolean): DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { allowExtension });
  try {
    configureMemorySqliteWalMaintenance(db, {
      busyTimeoutMs: 5000,
      databasePath: dbPath,
    });
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {}
    throw err;
  }
}

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
}
