import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";

export type MemoryWatchFile = { root: Root; relative: string; sample: boolean };
export type MemoryWatchEventStats = { size: number; mtimeMs: number };
type PendingFile = { file: MemoryWatchFile; snapshot: MemoryWatchEventStats | null };
export type MemoryWatchSettleQueue = Map<string, PendingFile>;
export const MEMORY_WATCH_MAX_PATHS = 1024;
const MEMORY_WATCH_SETTLE_RECHECK_MS = 100;

export class MemoryWatchMetadataCloseError extends Error {
  constructor(cause: unknown) {
    super("Memory metadata handle cleanup failed", { cause });
  }
}

function snapshotsMatch(
  left: MemoryWatchEventStats | null,
  right: MemoryWatchEventStats | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function snapshotPath(file: MemoryWatchFile): Promise<MemoryWatchEventStats | null> {
  if (!file.sample) {
    return null;
  }
  let opened: Awaited<ReturnType<Root["open"]>>;
  try {
    // Root.stat follows contained aliases even with reject read defaults. Only
    // guarded no-follow regular-file opens may sample a selected dirty path.
    opened = await file.root.open("./" + file.relative, {
      symlinks: "reject",
    });
  } catch {
    // Removed/rejected entries still invalidate the domain's guarded indexer.
    return null;
  }
  // Root.open captured the metadata already. Retire the handle before reading
  // that in-memory snapshot, so even an unexpected snapshot error cannot leak it.
  try {
    await opened[Symbol.asyncDispose]();
  } catch (error) {
    throw new MemoryWatchMetadataCloseError(error);
  }
  return opened.stat.isFile() ? { size: opened.stat.size, mtimeMs: opened.stat.mtimeMs } : null;
}

/** False means overflow: the owner must retain whole-source invalidation. */
export function recordMemoryWatchEventPath(
  queue: MemoryWatchSettleQueue,
  file: MemoryWatchFile,
  snapshot: MemoryWatchEventStats | null = null,
): boolean {
  const key = path.resolve(file.root.rootDir, file.relative);
  queue.set(key, { file, snapshot });
  if (queue.size <= MEMORY_WATCH_MAX_PATHS) {
    return true;
  }
  queue.clear();
  return false;
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
