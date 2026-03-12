import { readJsonFile, writeJsonFile } from "./storage.js";

const seen = new Map<string, number>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_KEYS = 20_000;
const TRIM_COUNT = 2_000;
const FILE = "dedup.json";
const PERSIST_DEBOUNCE_MS = Math.max(10, Number(process.env.WEMP_DEDUP_PERSIST_DEBOUNCE_MS || 250));
const CLEANUP_INTERVAL_CALLS = 100;
const CLEANUP_INTERVAL_MS = 30_000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDirty = false;
let callsSinceCleanup = 0;
let lastCleanupAt = Date.now();

const persisted = readJsonFile<Record<string, number>>(FILE, {});
for (const [key, expireAt] of Object.entries(persisted)) {
  if (typeof expireAt === "number") seen.set(key, expireAt);
}

function writePersistedSnapshot(): void {
  const out: Record<string, number> = {};
  for (const [key, expireAt] of seen.entries()) out[key] = expireAt;
  writeJsonFile(FILE, out);
}

function flushPersistNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistDirty) return;
  persistDirty = false;
  writePersistedSnapshot();
}

function schedulePersist(): void {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!persistDirty) return;
    persistDirty = false;
    writePersistedSnapshot();
  }, PERSIST_DEBOUNCE_MS);
  (persistTimer as any)?.unref?.();
}

process.once("beforeExit", () => {
  flushPersistNow();
});

function trimIfNeeded(): void {
  if (seen.size <= MAX_KEYS) return;
  let removed = 0;
  for (const key of seen.keys()) {
    seen.delete(key);
    removed += 1;
    if (removed >= TRIM_COUNT) break;
  }
  schedulePersist();
}

function cleanup(now: number, ttlMs: number): void {
  let changed = false;
  for (const [key, expireAt] of seen.entries()) {
    if (expireAt <= now) {
      seen.delete(key);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}

export function buildDedupKey(params: {
  accountId: string;
  openId?: string;
  msgId?: string;
  event?: string;
  eventKey?: string;
  createTime?: string;
}): string {
  return [
    params.accountId,
    params.openId || "-",
    params.msgId || "-",
    params.event || "-",
    params.eventKey || "-",
    params.createTime || "-",
  ].join(":");
}

export function markIfNew(key: string, ttlMs = DEFAULT_TTL_MS): boolean {
  const now = Date.now();
  callsSinceCleanup += 1;
  if (callsSinceCleanup >= CLEANUP_INTERVAL_CALLS || now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
    cleanup(now, ttlMs);
    callsSinceCleanup = 0;
    lastCleanupAt = now;
  }
  const expireAt = seen.get(key);
  if (expireAt && expireAt > now) return false;
  seen.set(key, now + ttlMs);
  trimIfNeeded();
  schedulePersist();
  return true;
}
