import fs from "node:fs";
/**
 * In-memory cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 * Follows a similar TTL pattern to the MS Teams and Telegram sent-message caches.
 *
 * The cache is persisted to disk so that thread participation survives gateway
 * restarts.  Writes are debounced (at most once per PERSIST_DEBOUNCE_MS) and
 * reads happen once on first access.
 */
import path from "node:path";
import { STATE_DIR } from "openclaw/plugin-sdk/state-paths";
import { resolveGlobalMap } from "openclaw/plugin-sdk/text-runtime";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;
const PERSIST_DEBOUNCE_MS = 5_000;
const PERSIST_FILENAME = "slack-thread-participation.json";

/**
 * Keep Slack thread participation AND its hydration/persist state shared
 * across bundled chunks so that prepare/dispatch code-split instances all
 * agree on whether disk has been loaded and share the same debounce timer.
 *
 * Using Symbol.for ensures the same key resolves across separate module
 * instances that may be bundled into different chunks.
 */
const SLACK_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.slackThreadParticipation");
const SLACK_THREAD_CACHE_STATE_KEY = Symbol.for("openclaw.slackThreadParticipationState");

interface CacheState {
  loaded: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persistPathOverride: string | undefined;
}

function getCacheState(): CacheState {
  const g = globalThis as unknown as Record<symbol, CacheState>;
  if (!g[SLACK_THREAD_CACHE_STATE_KEY]) {
    g[SLACK_THREAD_CACHE_STATE_KEY] = {
      loaded: false,
      persistTimer: null,
      persistPathOverride: undefined,
    };
  }
  return g[SLACK_THREAD_CACHE_STATE_KEY];
}

let threadParticipation: Map<string, number> | undefined;

function getThreadParticipation(): Map<string, number> {
  threadParticipation ??= resolveGlobalMap<string, number>(SLACK_THREAD_PARTICIPATION_KEY);
  return threadParticipation;
}

function persistPath(): string {
  const { persistPathOverride } = getCacheState();
  if (persistPathOverride) {
    return persistPathOverride;
  }
  return path.join(STATE_DIR, PERSIST_FILENAME);
}

function loadFromDisk(): void {
  const state = getCacheState();
  if (state.loaded) {
    return;
  }
  state.loaded = true;
  try {
    const raw = fs.readFileSync(persistPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const entries = parsed as Record<string, unknown>;
    const now = Date.now();
    const map = getThreadParticipation();
    for (const [key, ts] of Object.entries(entries)) {
      if (typeof ts === "number" && now - ts <= TTL_MS) {
        map.set(key, ts);
      }
    }
  } catch {
    // File missing or corrupt — start fresh.
  }
}

function persistToDisk(): void {
  const map = getThreadParticipation();
  const obj: Record<string, number> = {};
  for (const [key, ts] of map) {
    obj[key] = ts;
  }
  try {
    const dir = path.dirname(persistPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(persistPath(), JSON.stringify(obj), "utf8");
  } catch {
    // Best-effort — filesystem errors should not crash the gateway.
  }
}

function schedulePersist(): void {
  const state = getCacheState();
  if (state.persistTimer) {
    return;
  }
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    persistToDisk();
  }, PERSIST_DEBOUNCE_MS);
  // Don't hold the process open for a debounced persist.
  if (typeof state.persistTimer === "object" && "unref" in state.persistTimer) {
    state.persistTimer.unref();
  }
}

function makeKey(accountId: string, channelId: string, threadTs: string): string {
  return `${accountId}:${channelId}:${threadTs}`;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [key, timestamp] of getThreadParticipation()) {
    if (now - timestamp > TTL_MS) {
      getThreadParticipation().delete(key);
    }
  }
}

function evictOldest(): void {
  const oldest = getThreadParticipation().keys().next().value;
  if (oldest) {
    getThreadParticipation().delete(oldest);
  }
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  loadFromDisk();
  const map = getThreadParticipation();
  if (map.size >= MAX_ENTRIES) {
    evictExpired();
  }
  if (map.size >= MAX_ENTRIES) {
    evictOldest();
  }
  map.set(makeKey(accountId, channelId, threadTs), Date.now());
  schedulePersist();
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  loadFromDisk();
  const key = makeKey(accountId, channelId, threadTs);
  const map = getThreadParticipation();
  const timestamp = map.get(key);
  if (timestamp == null) {
    return false;
  }
  if (Date.now() - timestamp > TTL_MS) {
    map.delete(key);
    return false;
  }
  return true;
}

export function clearSlackThreadParticipationCache(): void {
  const state = getCacheState();
  getThreadParticipation().clear();
  if (state.persistTimer) {
    clearTimeout(state.persistTimer);
    state.persistTimer = null;
  }
  // Persist the empty state so the clear survives restarts.
  // We persist even if the cache hasn't been loaded yet — an existing
  // persist file with stale entries should be wiped.
  persistToDisk();
  state.loaded = true;
}

/** @internal — test helper to override persist path and reset load state. */
export function _resetForTests(overridePath?: string): void {
  const state = getCacheState();
  getThreadParticipation().clear();
  if (state.persistTimer) {
    clearTimeout(state.persistTimer);
    state.persistTimer = null;
  }
  state.loaded = false;
  state.persistPathOverride = overridePath;
}

/** @internal — flush any pending persist immediately (for tests). */
export function _flushPersist(): void {
  const state = getCacheState();
  if (state.persistTimer) {
    clearTimeout(state.persistTimer);
    state.persistTimer = null;
  }
  persistToDisk();
}
