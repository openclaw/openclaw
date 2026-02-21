// Persistent message deduplication store for Feishu channel.
// Prevents duplicate processing when WebSocket reconnects, Feishu redelivers messages,
// or OpenClaw restarts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Default TTL: 24 hours (much longer than memory-based dedup)
const DEFAULT_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
// Max entries per account to prevent unbounded growth
const DEFAULT_MAX_ENTRIES = 10_000;
// Run cleanup only when size exceeds this (avoids cleanup on every message in high traffic)
const CLEANUP_SIZE_THRESHOLD = 11_000;
// Cleanup probability when over DEFAULT_MAX_ENTRIES but under threshold
const CLEANUP_PROBABILITY = 0.01;

// In-memory cache per account (accountId -> (messageId -> timestamp))
const memoryCache = new Map<string, Map<string, number>>();
// Per-account lock to prevent concurrent read-modify-write (webhook mode race)
const accountLocks = new Map<string, Promise<unknown>>();
// In-flight ops per (accountId, messageId): later callers wait and return false (TOCTOU)
const inflight = new Map<
  string,
  Map<string, { promise: Promise<boolean>; resolve: (v: boolean) => void }>
>();

interface DedupStore {
  version: 1;
  messages: Array<{
    id: string;
    ts: number;
  }>;
}

function resolveStateDir(): string {
  // Use OPENCLAW_STATE_DIR env var or fallback to ~/.openclaw
  const envDir = process.env.OPENCLAW_STATE_DIR;
  if (envDir) {
    return envDir;
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveDedupDir(): string {
  const stateDir = resolveStateDir();
  const dir = path.join(stateDir, "feishu-dedup");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function resolveDedupFilePath(accountId: string): string {
  const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveDedupDir(), `${safe}-dedup.json`);
}

function getMemoryCache(accountId: string): Map<string, number> {
  let cache = memoryCache.get(accountId);
  if (!cache) {
    cache = new Map();
    memoryCache.set(accountId, cache);
  }
  return cache;
}

function getInflightMap(
  accountId: string,
): Map<string, { promise: Promise<boolean>; resolve: (v: boolean) => void }> {
  let m = inflight.get(accountId);
  if (!m) {
    m = new Map();
    inflight.set(accountId, m);
  }
  return m;
}

async function loadStore(accountId: string): Promise<DedupStore> {
  const filePath = resolveDedupFilePath(accountId);
  try {
    const data = await fs.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(data) as DedupStore;
    if (parsed.version === 1 && Array.isArray(parsed.messages)) {
      return parsed;
    }
  } catch {
    // File doesn't exist or is corrupted
  }
  return { version: 1, messages: [] };
}

async function saveStore(accountId: string, store: DedupStore): Promise<void> {
  const filePath = resolveDedupFilePath(accountId);
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(store), "utf8");
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

function cleanupExpiredEntries(
  messages: Array<{ id: string; ts: number }>,
  ttlMs: number,
  now: number,
): Array<{ id: string; ts: number }> {
  const cutoff = now - ttlMs;
  return messages.filter((m) => m.ts > cutoff);
}

/** Serialize read-modify-write per account to prevent webhook-mode race. */
function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) ?? Promise.resolve();
  const current = prev.then(
    () => fn(),
    () => fn(),
  );
  accountLocks.set(accountId, current);
  return current as Promise<T>;
}

/**
 * Try to record a message as processed for the given account.
 * Returns true if the message is new (should be processed), false if already processed.
 * Uses inflight tracking so concurrent callers for the same messageId don't both do loadStore — one wins, others wait and return false.
 */
export async function tryRecordMessagePersistent(
  accountId: string,
  messageId: string,
): Promise<boolean> {
  const now = Date.now();
  const cache = getMemoryCache(accountId);

  // Fast path: check memory cache first (no lock needed)
  if (cache.has(messageId)) {
    return false;
  }

  // If another call for this (accountId, messageId) is in flight, wait and return false (we're duplicate)
  const inflightForAccount = getInflightMap(accountId);
  const existing = inflightForAccount.get(messageId);
  if (existing) {
    await existing.promise;
    return false;
  }

  let resolveInflight!: (v: boolean) => void;
  const promise = new Promise<boolean>((res) => {
    resolveInflight = res;
  });
  inflightForAccount.set(messageId, { promise, resolve: resolveInflight });
  try {
    const result = await withAccountLock(accountId, async () => {
      if (cache.has(messageId)) {
        return false;
      }
      const store = await loadStore(accountId);
      if (store.messages.some((m) => m.id === messageId)) {
        cache.set(messageId, now);
        return false;
      }
      store.messages.push({ id: messageId, ts: now });
      cache.set(messageId, now);
      if (
        store.messages.length > CLEANUP_SIZE_THRESHOLD ||
        (Math.random() < CLEANUP_PROBABILITY && store.messages.length > DEFAULT_MAX_ENTRIES)
      ) {
        store.messages = cleanupExpiredEntries(store.messages, DEFAULT_DEDUP_TTL_MS, now);
        if (store.messages.length > DEFAULT_MAX_ENTRIES) {
          store.messages = store.messages.slice(-DEFAULT_MAX_ENTRIES);
        }
      }
      await saveStore(accountId, store);
      return true;
    });
    resolveInflight(result);
    return result;
  } finally {
    inflightForAccount.delete(messageId);
  }
}

/**
 * Check if a message was already processed for the given account (without recording it).
 */
export async function isMessageProcessed(accountId: string, messageId: string): Promise<boolean> {
  const cache = getMemoryCache(accountId);
  if (cache.has(messageId)) {
    return true;
  }
  const store = await loadStore(accountId);
  return store.messages.some((m) => m.id === messageId);
}

/**
 * Clear deduplication store for an account (useful for testing).
 * Idempotent: no-op if the file does not exist (e.g. first run or already cleared).
 */
export async function clearDedupStore(accountId: string = "default"): Promise<void> {
  memoryCache.delete(accountId);
  accountLocks.delete(accountId);
  inflight.delete(accountId);
  try {
    await fs.promises.unlink(resolveDedupFilePath(accountId));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return; // File not present — already cleared or never written
    }
    throw err;
  }
}
