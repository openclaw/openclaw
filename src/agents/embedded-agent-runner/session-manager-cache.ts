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
  return Math.min(
    Math.max(ttlMs, MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS),
    MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS,
  );
}

export type SessionManagerCache = {
  clear: () => void;
  isSessionManagerCached: (sessionFile: string) => boolean;
  keys: () => string[];
  prewarmSessionFile: (sessionFile: string) => Promise<void>;
  trackSessionManagerAccess: (sessionFile: string) => void;
};

/**
 * Builds the short-lived session-file warmup cache used by attempt and
 * compaction paths before they hand a JSONL session to SessionManager.
 *
 * The cache stores only paths that were recently accessed or successfully
 * prewarmed; it never owns file contents, so TTL expiry is enough to keep stale
 * session handles out of later runs.
 */
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
        // Read a small chunk to encourage OS page cache warmup without pulling
        // large transcripts into user-space memory before SessionManager opens them.
        const handle = await fsModule.open(sessionFile, "r");
        try {
          const buffer = Buffer.alloc(4096);
          await handle.read(buffer, 0, buffer.length, 0);
        } finally {
          await handle.close();
        }
        cache.set(sessionFile, true);
      } catch {
        // File doesn't exist yet, SessionManager will create it
      }
    },
    trackSessionManagerAccess: (sessionFile) => {
      cache.set(sessionFile, true);
    },
  };
}

const sessionManagerCache = createSessionManagerCache();

/** Records a session-file access in the process-wide warmup cache. */
export function trackSessionManagerAccess(sessionFile: string): void {
  sessionManagerCache.trackSessionManagerAccess(sessionFile);
}

/** Prewarms a session file through the process-wide cache before SessionManager reads it. */
export async function prewarmSessionFile(sessionFile: string): Promise<void> {
  await sessionManagerCache.prewarmSessionFile(sessionFile);
}
