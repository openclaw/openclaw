import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import { isCacheEnabled, resolveCacheTtlMs } from "../../config/cache-utils.js";

type SessionManagerCacheEntry = {
  sessionFile: string;
  loadedAt: number;
};

const SESSION_MANAGER_CACHE = new Map<string, SessionManagerCacheEntry>();
const DEFAULT_SESSION_MANAGER_TTL_MS = 45_000; // 45 seconds
const MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 1_000;
const MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 30_000;

let lastSessionManagerCachePruneAt = 0;

function getSessionManagerTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_MANAGER_TTL_MS,
  });
}

function isSessionManagerCacheEnabled(): boolean {
  return isCacheEnabled(getSessionManagerTtl());
}

function resolveSessionManagerCachePruneInterval(ttlMs: number): number {
  return Math.min(
    Math.max(ttlMs, MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS),
    MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS,
  );
}

function maybePruneExpiredSessionManagerCache(now: number, ttlMs: number): void {
  if (now - lastSessionManagerCachePruneAt < resolveSessionManagerCachePruneInterval(ttlMs)) {
    return;
  }
  for (const [sessionFile, entry] of SESSION_MANAGER_CACHE.entries()) {
    if (now - entry.loadedAt > ttlMs) {
      SESSION_MANAGER_CACHE.delete(sessionFile);
    }
  }
  lastSessionManagerCachePruneAt = now;
}

export function trackSessionManagerAccess(sessionFile: string): void {
  const ttl = getSessionManagerTtl();
  if (!isCacheEnabled(ttl)) {
    return;
  }
  const now = Date.now();
  maybePruneExpiredSessionManagerCache(now, ttl);
  SESSION_MANAGER_CACHE.set(sessionFile, {
    sessionFile,
    loadedAt: now,
  });
}

function isSessionManagerCached(sessionFile: string): boolean {
  const ttl = getSessionManagerTtl();
  if (!isCacheEnabled(ttl)) {
    return false;
  }
  const now = Date.now();
  maybePruneExpiredSessionManagerCache(now, ttl);
  const entry = SESSION_MANAGER_CACHE.get(sessionFile);
  if (!entry) {
    return false;
  }
  return now - entry.loadedAt <= ttl;
}

export async function prewarmSessionFile(sessionFile: string): Promise<void> {
  if (!isSessionManagerCacheEnabled()) {
    return;
  }
  if (isSessionManagerCached(sessionFile)) {
    return;
  }

  try {
    // Read a small chunk to encourage OS page cache warmup.
    const handle = await fs.open(sessionFile, "r");
    try {
      const buffer = Buffer.alloc(4096);
      await handle.read(buffer, 0, buffer.length, 0);
    } finally {
      await handle.close();
    }
    trackSessionManagerAccess(sessionFile);
  } catch {
    // File doesn't exist yet, SessionManager will create it
  }
}

export const __testing = {
  getSessionManagerCacheKeys(): string[] {
    return [...SESSION_MANAGER_CACHE.keys()];
  },
  resetSessionManagerCache(): void {
    SESSION_MANAGER_CACHE.clear();
    lastSessionManagerCachePruneAt = 0;
  },
};
