// Memory Core plugin module implements cross-process safe-reindex locking.
// The dedicated sibling DB follows custom store paths and relies on SQLite to
// release its exclusive transaction automatically after process/container death.
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemoryReindexLockHandle = {
  release: () => void;
};

export function resolveMemoryReindexLockPath(dbPath: string): string {
  return `${dbPath}.reindex-lock.sqlite`;
}

function isSqliteBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(message);
}

function openMemoryReindexLockDatabase(dbPath: string): DatabaseSync {
  const lockPath = resolveMemoryReindexLockPath(dbPath);
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

export function tryAcquireMemoryReindexLock(dbPath: string): MemoryReindexLockHandle | undefined {
  const lockDb = openMemoryReindexLockDatabase(dbPath);
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
        throw new Error("Failed to release memory reindex lock", { cause: releaseError });
      }
    },
  };
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
