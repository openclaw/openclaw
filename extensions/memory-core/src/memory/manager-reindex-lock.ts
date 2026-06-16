// Memory Core plugin module serializes full memory reindex builds across processes.
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

/** Acquire an exclusive build lock without locking readers of the live agent database. */
export function acquireMemoryReindexLock(dbPath: string): MemoryReindexLockHandle {
  const lockPath = resolveMemoryReindexLockPath(dbPath);
  const lockDb = openMemoryLockDatabase(lockPath);
  try {
    lockDb.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    lockDb.close();
    if (isSqliteBusyError(err)) {
      throw Object.assign(
        new Error(`Memory reindex lock is held at ${lockPath}; another reindex is active.`),
        { code: "SQLITE_BUSY" },
      );
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
