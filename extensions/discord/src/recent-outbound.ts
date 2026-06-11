import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

type RecentDiscordOutboundMessage = {
  accountId: string;
  channelId: string;
  messageId: string;
  at: number;
};

// Best-effort reconnect recovery anchor: scoped to recent bot outbounds.
// Unlike the first in-memory-only version, this store is persisted so a full
// Gateway restart can still catch user replies that Discord delivered while the
// old process was wedged/starved. This is still deliberately bounded; it is not
// a general-purpose Discord history sync.
const RECENT_OUTBOUND_MAX = 500;
const RECENT_OUTBOUND_CHANNEL_WINDOW_MS = 15 * 60 * 1000;
const RECENT_OUTBOUND_PERSIST_WINDOW_MS = 2 * 60 * 60 * 1000;
const RECENT_OUTBOUND_STORE_VERSION = 1;
const RECENT_OUTBOUND_STORE_PATH_ENV = "OPENCLAW_DISCORD_RECENT_OUTBOUND_STORE_PATH";
const RECENT_OUTBOUND_DISABLE_PERSISTENCE_ENV =
  "OPENCLAW_DISCORD_RECENT_OUTBOUND_DISABLE_PERSISTENCE";
const recentOutboundByKey = new Map<string, RecentDiscordOutboundMessage>();
let persistenceLoadedMaxAgeMs = 0;

function normalize(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

function keyFor(accountId: string, channelId: string) {
  return `${accountId || "default"}:${channelId}`;
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function normalizePersistedEntry(value: unknown): RecentDiscordOutboundMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<RecentDiscordOutboundMessage>;
  const accountId = normalize(record.accountId) || "default";
  const channelId = normalize(record.channelId);
  const messageId = normalize(record.messageId);
  const at = normalizeTimestamp(record.at);
  if (!channelId || !messageId || at === null) {
    return null;
  }
  return { accountId, channelId, messageId, at };
}

function resolveRecentOutboundStorePath(): string | null {
  if (process.env[RECENT_OUTBOUND_DISABLE_PERSISTENCE_ENV] === "1") {
    return null;
  }
  const override = process.env[RECENT_OUTBOUND_STORE_PATH_ENV]?.trim();
  if (override) {
    return path.resolve(override);
  }
  // Vitest should not write into a developer's real state dir unless a test
  // explicitly opts in with OPENCLAW_DISCORD_RECENT_OUTBOUND_STORE_PATH.
  if (process.env.NODE_ENV === "test") {
    return null;
  }
  return path.join(resolveStateDir(process.env), "discord", "recent-outbound.json");
}

function readPersistedRecentOutbound(
  now: number,
  maxAgeMs: number,
): RecentDiscordOutboundMessage[] {
  const storePath = resolveRecentOutboundStorePath();
  if (!storePath) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : [];
  return entries
    .map(normalizePersistedEntry)
    .filter((entry): entry is RecentDiscordOutboundMessage => Boolean(entry))
    .filter((entry) => now - entry.at <= maxAgeMs)
    .toSorted((a, b) => a.at - b.at);
}

function loadPersistedRecentOutbound(now: number, maxAgeMs: number) {
  if (persistenceLoadedMaxAgeMs >= maxAgeMs) {
    return;
  }
  persistenceLoadedMaxAgeMs = maxAgeMs;
  for (const entry of readPersistedRecentOutbound(now, maxAgeMs)) {
    const key = keyFor(entry.accountId, entry.channelId);
    const existing = recentOutboundByKey.get(key);
    // Prefer the oldest still-valid anchor for a channel so a startup catch-up
    // scans across the largest bounded gap after a full process restart.
    if (!existing || entry.at < existing.at) {
      recentOutboundByKey.set(key, entry);
    }
  }
}

function trimRecentOutbound(now: number, maxAgeMs: number) {
  for (const [key, entry] of recentOutboundByKey) {
    if (now - entry.at > maxAgeMs) {
      recentOutboundByKey.delete(key);
    }
  }
  if (recentOutboundByKey.size <= RECENT_OUTBOUND_MAX) {
    return;
  }
  const sorted = [...recentOutboundByKey.entries()].toSorted((a, b) => a[1].at - b[1].at);
  for (const [key] of sorted.slice(0, recentOutboundByKey.size - RECENT_OUTBOUND_MAX)) {
    recentOutboundByKey.delete(key);
  }
}

function persistRecentOutbound(now: number) {
  const storePath = resolveRecentOutboundStorePath();
  if (!storePath) {
    return;
  }
  try {
    trimRecentOutbound(now, RECENT_OUTBOUND_PERSIST_WINDOW_MS);
    const entries = [...recentOutboundByKey.values()]
      .filter((entry) => now - entry.at <= RECENT_OUTBOUND_PERSIST_WINDOW_MS)
      .toSorted((a, b) => a.at - b.at);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      tmpPath,
      `${JSON.stringify({ version: RECENT_OUTBOUND_STORE_VERSION, entries }, null, 2)}\n`,
      "utf8",
    );
    fs.renameSync(tmpPath, storePath);
  } catch {
    // Best-effort resilience cache only. Outbound Discord sends must not fail
    // because this optional recovery anchor could not be persisted.
  }
}

export function recordRecentDiscordOutboundMessage(params: {
  accountId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  at?: number;
}) {
  const accountId = normalize(params.accountId) || "default";
  const channelId = normalize(params.channelId);
  const messageId = normalize(params.messageId);
  if (!channelId || !messageId) {
    return;
  }
  const at = params.at ?? Date.now();
  loadPersistedRecentOutbound(at, RECENT_OUTBOUND_PERSIST_WINDOW_MS);
  const key = keyFor(accountId, channelId);
  const existing = recentOutboundByKey.get(key);
  if (existing && at - existing.at <= RECENT_OUTBOUND_CHANNEL_WINDOW_MS) {
    trimRecentOutbound(at, RECENT_OUTBOUND_PERSIST_WINDOW_MS);
    persistRecentOutbound(at);
    return;
  }
  recentOutboundByKey.set(key, {
    accountId,
    channelId,
    messageId,
    at,
  });
  trimRecentOutbound(at, RECENT_OUTBOUND_PERSIST_WINDOW_MS);
  persistRecentOutbound(at);
}

export function listRecentDiscordOutboundMessages(params: {
  accountId?: string | null;
  maxAgeMs: number;
  now?: number;
}): RecentDiscordOutboundMessage[] {
  const accountId = normalize(params.accountId) || "default";
  const now = params.now ?? Date.now();
  loadPersistedRecentOutbound(now, params.maxAgeMs);
  trimRecentOutbound(now, params.maxAgeMs);
  return [...recentOutboundByKey.values()].filter(
    (entry) => entry.accountId === accountId && now - entry.at <= params.maxAgeMs,
  );
}

export function resetRecentDiscordOutboundMessagesForTest() {
  recentOutboundByKey.clear();
  persistenceLoadedMaxAgeMs = 0;
}

export function clearRecentDiscordOutboundPersistenceForTest() {
  const storePath = resolveRecentOutboundStorePath();
  if (!storePath) {
    return;
  }
  try {
    fs.rmSync(storePath, { force: true });
  } catch {
    // test helper only
  }
}
