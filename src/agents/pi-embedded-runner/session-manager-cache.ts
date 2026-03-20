import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import { isCacheEnabled, resolveCacheTtlMs } from "../../config/cache-utils.js";

type SessionManagerCacheEntry = {
  sessionFile: string;
  loadedAt: number;
};

const SESSION_MANAGER_CACHE = new Map<string, SessionManagerCacheEntry>();
const DEFAULT_SESSION_MANAGER_TTL_MS = 45_000; // 45 seconds
// Safety-net cap. Working set is far smaller (entries live ≤45 s);
// env override is intentionally not exposed — 500 >> realistic working set.
const SESSION_MANAGER_CACHE_MAX_SIZE = 500;

function getSessionManagerTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_MANAGER_TTL_MS,
  });
}

function isSessionManagerCacheEnabled(): boolean {
  return isCacheEnabled(getSessionManagerTtl());
}

export function trackSessionManagerAccess(sessionFile: string): void {
  if (!isSessionManagerCacheEnabled()) {
    return;
  }
  // Refresh insertion order for existing keys so FIFO eviction is LRU-like.
  // Map.set() on an existing key does NOT update insertion order (MDN), so
  // we delete first to move it to the end.
  if (SESSION_MANAGER_CACHE.has(sessionFile)) {
    SESSION_MANAGER_CACHE.delete(sessionFile);
  }
  // Evict oldest entry when the cache is at its size limit.
  // Map iteration order is insertion-order, so the first key is the oldest.
  if (SESSION_MANAGER_CACHE.size >= SESSION_MANAGER_CACHE_MAX_SIZE) {
    const oldest = SESSION_MANAGER_CACHE.keys().next();
    if (!oldest.done) {
      SESSION_MANAGER_CACHE.delete(oldest.value);
    }
  }
  const now = Date.now();
  SESSION_MANAGER_CACHE.set(sessionFile, {
    sessionFile,
    loadedAt: now,
  });
}

function isSessionManagerCached(sessionFile: string): boolean {
  if (!isSessionManagerCacheEnabled()) {
    return false;
  }
  const entry = SESSION_MANAGER_CACHE.get(sessionFile);
  if (!entry) {
    return false;
  }
  const now = Date.now();
  const ttl = getSessionManagerTtl();
  if (now - entry.loadedAt > ttl) {
    SESSION_MANAGER_CACHE.delete(sessionFile);
    return false;
  }
  return true;
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

/**
 * Clear all cached entries.  Exported for tests and graceful-shutdown hooks.
 */
export function clearSessionManagerCache(): void {
  SESSION_MANAGER_CACHE.clear();
}

/**
 * Return the current number of entries in the cache.
 * @internal Visible for testing only.
 */
export function sessionManagerCacheSize(): number {
  return SESSION_MANAGER_CACHE.size;
}
