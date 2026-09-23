// Memory Core plugin module serializes full memory reindex builds across processes.
import {
  acquireMemorySqliteWriterLease,
  type MemorySqliteLeaseHandle,
} from "./manager-sqlite-lease.js";

export type MemoryReindexLockHandle = MemorySqliteLeaseHandle;

const REINDEX_LOCK_WAIT_TIMEOUT_MS = 2_000;
function createMemoryReindexBusyError(lockPath: string): Error & { code: string } {
  return Object.assign(
    new Error(`Memory reindex lock is held at ${lockPath}; another reindex is active.`),
    { code: "SQLITE_BUSY" },
  );
}

/** Wait asynchronously for the exclusive build lock without blocking the Node event loop. */
export async function waitForMemoryReindexLock(
  dbPath: string,
  options: { waitForActive?: boolean } = {},
): Promise<MemoryReindexLockHandle> {
  const lockPath = `${dbPath}.reindex-lock.sqlite`;
  // Reset refuses a busy index; admitted sync work waits for its writer to settle.
  const timeout = options.waitForActive
    ? undefined
    : AbortSignal.timeout(REINDEX_LOCK_WAIT_TIMEOUT_MS);
  try {
    return await acquireMemorySqliteWriterLease(lockPath, timeout);
  } catch (error) {
    if (timeout?.aborted) {
      throw createMemoryReindexBusyError(lockPath);
    }
    throw error;
  }
}
