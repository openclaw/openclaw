import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import {
  createExpiringMapCache,
  isCacheEnabled,
  resolveCacheTtlMs,
} from "../../config/cache-utils.js";

const DEFAULT_SESSION_MANAGER_TTL_MS = 45_000; // 45 seconds
const MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 1_000;
const MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 30_000;

function getSessionManagerTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_MANAGER_TTL_MS,
  });
}

function resolveSessionManagerCachePruneInterval(ttlMs: number): number {
  // Prune at least once per second for short-lived test caches, but cap long
  // production TTLs so stale session-file markers do not linger for minutes.
  return Math.min(
    Math.max(ttlMs, MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS),
    MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS,
  );
}

/** Tracks recently opened session files so retry/compaction paths can prewarm disk reads. */
export type SessionManagerCache = {
  clear: () => void;
  isSessionManagerCached: (sessionFile: string) => boolean;
  keys: () => string[];
  prewarmSessionFile: (sessionFile: string) => Promise<void>;
  trackSessionManagerAccess: (sessionFile: string) => void;
};

/** Creates a TTL-bound session-file cache with injectable clock and fs handles for tests. */
export function createSessionManagerCache(options?: {
  clock?: () => number;
  fsModule?: Pick<typeof fs, "open">;
  ttlMs?: number | (() => number);
}): SessionManagerCache {
  const getTtlMs = () =>
    typeof options?.ttlMs === "function"
      ? options.ttlMs()
      : (options?.ttlMs ?? getSessionManagerTtl());
  const cache = createExpiringMapCache<string, true>({
    ttlMs: getTtlMs,
    pruneIntervalMs: resolveSessionManagerCachePruneInterval,
    clock: options?.clock,
  });
  const fsModule = options?.fsModule ?? fs;

  return {
    clear: () => {
      cache.clear();
    },
    isSessionManagerCached: (sessionFile) => cache.get(sessionFile) === true,
    keys: () => cache.keys(),
    prewarmSessionFile: async (sessionFile) => {
      if (!isCacheEnabled(getTtlMs())) {
        return;
      }
      if (cache.get(sessionFile) === true) {
        return;
      }

      try {
        // Reading a small prefix is enough to populate the OS page cache before
        // SessionManager reopens the JSONL during compaction/retry recovery.
        const handle = await fsModule.open(sessionFile, "r");
        try {
          const buffer = Buffer.alloc(4096);
          await handle.read(buffer, 0, buffer.length, 0);
        } finally {
          await handle.close();
        }
        cache.set(sessionFile, true);
      } catch {
        // A missing file is expected for first-use sessions; SessionManager will
        // create it, and the later write path records the access in this cache.
      }
    },
    trackSessionManagerAccess: (sessionFile) => {
      cache.set(sessionFile, true);
    },
  };
}

const sessionManagerCache = createSessionManagerCache();

/** Records that the live process has touched a session file recently. */
export function trackSessionManagerAccess(sessionFile: string): void {
  sessionManagerCache.trackSessionManagerAccess(sessionFile);
}

/** Warms the session file prefix before recovery paths rehydrate SessionManager state. */
export async function prewarmSessionFile(sessionFile: string): Promise<void> {
  await sessionManagerCache.prewarmSessionFile(sessionFile);
}
