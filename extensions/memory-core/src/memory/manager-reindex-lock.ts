// Memory Core plugin module implements cross-process safe-reindex locking.
// Dedicated sibling DBs follow custom store paths and rely on SQLite to release
// shared/exclusive transactions automatically after process/container death.
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemoryReindexLockHandle = {
  release: () => void;
};

export function resolveMemoryReindexLockPath(dbPath: string): string {
  return `${dbPath}.reindex-lock.sqlite`;
}

export function resolveMemoryReindexSwapLockPath(dbPath: string): string {
  // This sibling contains coordination state only, never memory index data.
  return `${dbPath}.reindex-swap-lock`;
}

function isSqliteBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(message);
}

function openMemoryLockDatabase(lockPath: string): DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const lockDb = new DatabaseSync(lockPath);
  try {
    lockDb.exec("PRAGMA busy_timeout = 0");
    return lockDb;
  } catch (err) {
    try {
      lockDb.close();
    } catch {}
    throw err;
  }
}

function createMemoryLockHandle(lockDb: DatabaseSync, label: string): MemoryReindexLockHandle {
  return {
    release: () => {
      let releaseError: unknown;
      try {
        lockDb.exec("ROLLBACK");
      } catch (err) {
        releaseError = err;
      }
      try {
        lockDb.close();
      } catch (err) {
        releaseError ??= err;
      }
      if (releaseError) {
        throw new Error(`Failed to release ${label}`, { cause: releaseError });
      }
    },
  };
}

function tryAcquireMemoryExclusiveLock(
  lockPath: string,
  label: string,
): MemoryReindexLockHandle | undefined {
  const lockDb = openMemoryLockDatabase(lockPath);
  try {
    // SQLite releases this transaction automatically when a process or
    // container dies, so ownership never depends on PID namespaces or leases.
    lockDb.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    lockDb.close();
    if (isSqliteBusyError(err)) {
      return undefined;
    }
    throw err;
  }
  return createMemoryLockHandle(lockDb, label);
}

export function tryAcquireMemoryReindexLock(dbPath: string): MemoryReindexLockHandle | undefined {
  return tryAcquireMemoryExclusiveLock(resolveMemoryReindexLockPath(dbPath), "memory reindex lock");
}

export function acquireMemoryReindexLock(dbPath: string): MemoryReindexLockHandle {
  const lock = tryAcquireMemoryReindexLock(dbPath);
  if (lock) {
    return lock;
  }
  throw Object.assign(
    new Error(
      `Memory reindex lock is held at ${resolveMemoryReindexLockPath(dbPath)}; another reindex is active.`,
    ),
    { code: "SQLITE_BUSY" },
  );
}

export function acquireMemoryReindexSwapReadLock(dbPath: string): MemoryReindexLockHandle {
  const lockDb = openMemoryLockDatabase(resolveMemoryReindexSwapLockPath(dbPath));
  try {
    // A deferred transaction only takes a shared lock after its first read.
    lockDb.exec("BEGIN");
    lockDb.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
  } catch (err) {
    lockDb.close();
    if (isSqliteBusyError(err)) {
      throw Object.assign(
        new Error(`Memory database at ${dbPath} is unavailable during a safe reindex swap.`, {
          cause: err,
        }),
        { code: "SQLITE_BUSY" },
      );
    }
    throw err;
  }
  return createMemoryLockHandle(lockDb, "memory reindex swap read lock");
}

export function tryAcquireMemoryReindexSwapLock(
  dbPath: string,
): MemoryReindexLockHandle | undefined {
  return tryAcquireMemoryExclusiveLock(
    resolveMemoryReindexSwapLockPath(dbPath),
    "memory reindex swap lock",
  );
}

export function acquireMemoryReindexSwapLock(dbPath: string): MemoryReindexLockHandle {
  const lock = tryAcquireMemoryReindexSwapLock(dbPath);
  if (lock) {
    return lock;
  }
  throw Object.assign(
    new Error(
      `Cannot publish memory reindex for ${dbPath}; another process is using the live database.`,
    ),
    { code: "SQLITE_BUSY" },
  );
}
