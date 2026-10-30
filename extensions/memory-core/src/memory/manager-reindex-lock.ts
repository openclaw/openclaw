// Memory Core serializes builds and reset within the owning Gateway.
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { enqueueKeyedTask } from "openclaw/plugin-sdk/keyed-async-queue";
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-fs";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";

export type MemoryReindexLockHandle = { release: () => Promise<void> };

const builds = new Map<string, Promise<void>>();
const REINDEX_LOCK_WAIT_TIMEOUT_MS = 2_000;
function createMemoryReindexBusyError(lockPath: string): Error & { code: string } {
  return Object.assign(
    new Error(`Memory reindex lock is held at ${lockPath}; another reindex is active.`),
    { code: "SQLITE_BUSY" },
  );
}

/** Old on-disk coordination files are inert; foreign writers must stop the Gateway. */
export async function waitForMemoryReindexLock(
  dbPath: string,
  options: { waitForActive?: boolean } = {},
): Promise<MemoryReindexLockHandle> {
  const lockPath = `${dbPath}.reindex-lock.sqlite`;
  const entered = createDeferred();
  const released = createDeferred();
  const completed = enqueueKeyedTask({
    tails: builds,
    key: resolveUserPath(dbPath),
    task: async () => {
      entered.resolve();
      await released.promise;
    },
  });
  // Reset refuses a busy index; admitted sync work waits for its writer to settle.
  const timeout = options.waitForActive
    ? undefined
    : AbortSignal.timeout(REINDEX_LOCK_WAIT_TIMEOUT_MS);
  try {
    if (timeout) {
      await racePromiseWithAbortSignal(entered.promise, timeout);
    } else {
      await entered.promise;
    }
    return {
      release: async () => {
        released.resolve();
        await completed;
      },
    };
  } catch (error) {
    released.resolve();
    if (timeout?.aborted) {
      throw createMemoryReindexBusyError(lockPath);
    }
    throw error;
  }
}
