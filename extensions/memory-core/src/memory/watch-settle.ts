import fs from "node:fs/promises";
import path from "node:path";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";

export type MemoryWatchEventStats = {
  isDirectory?: () => boolean;
  size?: number;
  mtimeMs?: number;
};

type WatchPathSnapshot = {
  size: number;
  mtimeMs: number;
};

export type MemoryWatchSettleQueue = Map<string, WatchPathSnapshot | null>;

/** Overflow reconciles the source; keep watch bursts bounded in the owner. */
export const MEMORY_WATCH_MAX_PATHS = 1024;
const MEMORY_WATCH_SETTLE_RECHECK_MS = 100;

function snapshotFromStats(stats?: MemoryWatchEventStats): WatchPathSnapshot | null {
  if (!stats || stats.isDirectory?.()) {
    return null;
  }
  if (typeof stats.size !== "number" || typeof stats.mtimeMs !== "number") {
    return null;
  }
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

function snapshotsMatch(left: WatchPathSnapshot | null, right: WatchPathSnapshot | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function snapshotPath(filePath: string): Promise<WatchPathSnapshot | null> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      return null;
    }
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

export function recordMemoryWatchEventPath(
  queue: MemoryWatchSettleQueue,
  watchPath?: string,
  stats?: MemoryWatchEventStats,
): void {
  if (!watchPath) {
    return;
  }
  const trimmed = watchPath.trim();
  if (!trimmed) {
    return;
  }
  queue.set(path.resolve(trimmed), snapshotFromStats(stats));
  if (queue.size > MEMORY_WATCH_MAX_PATHS) {
    queue.clear();
  }
}

export async function settleMemoryWatchEventPaths(
  queue: MemoryWatchSettleQueue,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (queue.size === 0) {
    return true;
  }

  const entries = Array.from(queue.entries());
  queue.clear();
  const missingBaseline: Array<{ filePath: string; snapshot: WatchPathSnapshot }> = [];

  for (const [filePath, previousSnapshot] of entries) {
    signal?.throwIfAborted();
    const currentSnapshot = await snapshotPath(filePath);
    signal?.throwIfAborted();
    if (previousSnapshot === null) {
      if (currentSnapshot !== null) {
        missingBaseline.push({ filePath, snapshot: currentSnapshot });
      }
      continue;
    }
    if (
      !snapshotsMatch(previousSnapshot, currentSnapshot) &&
      !queue.has(filePath) &&
      queue.size < MEMORY_WATCH_MAX_PATHS
    ) {
      queue.set(filePath, currentSnapshot);
    }
  }

  if (missingBaseline.length > 0) {
    await sleepWithAbort(MEMORY_WATCH_SETTLE_RECHECK_MS, signal);
    for (const entry of missingBaseline) {
      signal?.throwIfAborted();
      const currentSnapshot = await snapshotPath(entry.filePath);
      signal?.throwIfAborted();
      // A newer event owns its snapshot while this generation waits on I/O.
      if (
        !snapshotsMatch(entry.snapshot, currentSnapshot) &&
        !queue.has(entry.filePath) &&
        queue.size < MEMORY_WATCH_MAX_PATHS
      ) {
        queue.set(entry.filePath, currentSnapshot);
      }
    }
  }

  return queue.size === 0;
}
