import * as fs from "node:fs";
import * as path from "node:path";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";

/**
 * Persistent backing store for Slack thread participation.
 *
 * The in-memory cache in `sent-thread-cache.ts` is the hot path; this file
 * provides durability across process restarts so that requireMention channels
 * don't lose thread continuation when the gateway is restarted.
 *
 * The store is a flat JSON object keyed by "accountId:channelId:threadTs".
 * Values are { agentId, repliedAt } for auditability.
 */

type ParticipationEntry = {
  agentId: string;
  repliedAt: number;
};

type ParticipationStore = Record<string, ParticipationEntry>;

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — longer than in-memory (24h)
const MAX_ENTRIES = 10_000;
const STORE_FILENAME = "thread-participation.json";

// Module-level cache of the loaded store to avoid repeated reads within the
// same event loop tick.  Invalidated on write.
let cachedStore: ParticipationStore | null = null;
let cachedStorePath: string | null = null;

function makeKey(accountId: string, channelId: string, threadTs: string): string {
  return `${accountId}:${channelId}:${threadTs}`;
}

export function deriveParticipationStorePath(sessionStorePath: string): string {
  return path.join(path.dirname(sessionStorePath), STORE_FILENAME);
}

function loadStore(filePath: string): ParticipationStore {
  if (cachedStore && cachedStorePath === filePath) {
    return cachedStore;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ParticipationStore;
    cachedStore = parsed;
    cachedStorePath = filePath;
    return parsed;
  } catch {
    // File missing or corrupt — start fresh.
    cachedStore = {};
    cachedStorePath = filePath;
    return {};
  }
}

function saveStore(filePath: string, store: ParticipationStore): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
  cachedStore = store;
  cachedStorePath = filePath;
}

function pruneExpired(store: ParticipationStore, now: number): ParticipationStore {
  const cutoff = now - TTL_MS;
  const entries = Object.entries(store).filter(([, v]) => v.repliedAt >= cutoff);
  if (entries.length <= MAX_ENTRIES) {
    return Object.fromEntries(entries);
  }
  // Keep most recent MAX_ENTRIES.
  entries.sort((a, b) => b[1].repliedAt - a[1].repliedAt);
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

export function persistThreadParticipation(
  sessionStorePath: string,
  accountId: string,
  channelId: string,
  threadTs: string,
  agentId: string,
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  const filePath = deriveParticipationStorePath(sessionStorePath);
  const now = Date.now();
  const store = pruneExpired(loadStore(filePath), now);
  const key = makeKey(accountId, channelId, threadTs);
  store[key] = { agentId, repliedAt: now };
  try {
    saveStore(filePath, store);
    if (shouldLogVerbose()) {
      logVerbose(`slack thread-participation: persisted ${key} (agent=${agentId})`);
    }
  } catch (err) {
    // Non-fatal: in-memory cache still works.
    if (shouldLogVerbose()) {
      logVerbose(`slack thread-participation: persist failed for ${key}: ${String(err)}`);
    }
  }
}

export function hasPersistedThreadParticipation(
  sessionStorePath: string,
  accountId: string,
  channelId: string,
  threadTs: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  const filePath = deriveParticipationStorePath(sessionStorePath);
  const store = loadStore(filePath);
  const key = makeKey(accountId, channelId, threadTs);
  const entry = store[key];
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.repliedAt > TTL_MS) {
    return false;
  }
  return true;
}
