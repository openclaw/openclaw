import path from "node:path";
import {
  readObservationSnapshot,
  type ObservationRoot,
} from "openclaw/plugin-sdk/file-access-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";

export type MemoryWatchFile = { root: ObservationRoot; relative: string; sample: boolean };
type MemoryWatchEventStats = { size: number; mtimeMs: number };
type PendingFile = { file: MemoryWatchFile; snapshot: MemoryWatchEventStats | null };
export type MemoryWatchSettleQueue = Map<string, PendingFile>;
export const MEMORY_WATCH_MAX_PATHS = 1024;
const MEMORY_WATCH_SETTLE_RECHECK_MS = 100;

function snapshotsMatch(
  left: MemoryWatchEventStats | null,
  right: MemoryWatchEventStats | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function snapshotPath(file: MemoryWatchFile): Promise<MemoryWatchEventStats | null> {
  return file.sample ? ((await readObservationSnapshot(file.root, file.relative)) ?? null) : null;
}

export function recordMemoryWatchEventPath(
  queue: MemoryWatchSettleQueue,
  file: MemoryWatchFile,
): void {
  const key = path.resolve(file.root.rootDir, file.relative);
  queue.set(key, { file, snapshot: null });
  if (queue.size > MEMORY_WATCH_MAX_PATHS) {
    queue.clear();
  }
}

export async function settleMemoryWatchEventPaths(
  queue: MemoryWatchSettleQueue,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const entries = [...queue];
  queue.clear();
  const missingBaseline: Array<[string, PendingFile]> = [];
  const retain = (key: string, pending: PendingFile) => {
    if (!queue.has(key) && queue.size < MEMORY_WATCH_MAX_PATHS) {
      queue.set(key, pending);
    }
  };
  for (const [key, pending] of entries) {
    signal?.throwIfAborted();
    const snapshot = await snapshotPath(pending.file);
    signal?.throwIfAborted();
    if (pending.snapshot === null) {
      if (snapshot !== null) {
        missingBaseline.push([key, { file: pending.file, snapshot }]);
      }
    } else if (!snapshotsMatch(pending.snapshot, snapshot)) {
      retain(key, { file: pending.file, snapshot });
    }
  }
  if (missingBaseline.length) {
    await sleepWithAbort(MEMORY_WATCH_SETTLE_RECHECK_MS, signal);
    for (const [key, pending] of missingBaseline) {
      signal?.throwIfAborted();
      const snapshot = await snapshotPath(pending.file);
      signal?.throwIfAborted();
      // A newer event owns its snapshot while this generation waits on I/O.
      if (!snapshotsMatch(pending.snapshot, snapshot)) {
        retain(key, { file: pending.file, snapshot });
      }
    }
  }
  return queue.size === 0;
}
