import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import { isCacheEnabled, resolveCacheTtlMs } from "../../config/cache-utils.js";

type SessionManagerCacheEntry = {
  sessionFile: string;
  loadedAt: number;
};

const SESSION_MANAGER_CACHE = new Map<string, SessionManagerCacheEntry>();
const DEFAULT_SESSION_MANAGER_TTL_MS = 45_000; // 45 seconds
const CLEANUP_INTERVAL_MS = 60_000; // Sweep expired entries every 60 seconds
const MAX_CACHE_ENTRIES = 10_000; // Safety cap to prevent unbounded growth

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

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
  // Enforce max entries cap - evict oldest entry if at limit
  if (SESSION_MANAGER_CACHE.size >= MAX_CACHE_ENTRIES && !SESSION_MANAGER_CACHE.has(sessionFile)) {
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
  ensureCleanupTimer();
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

/** Sweep all expired entries from the cache. */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  const ttl = getSessionManagerTtl();
  for (const [key, entry] of SESSION_MANAGER_CACHE) {
    if (now - entry.loadedAt > ttl) {
      SESSION_MANAGER_CACHE.delete(key);
    }
  }
  // Stop the timer if cache is empty to avoid unnecessary work
  if (SESSION_MANAGER_CACHE.size === 0 && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function ensureCleanupTimer(): void {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);
  // Allow process to exit even if timer is running
  cleanupTimer.unref();
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
