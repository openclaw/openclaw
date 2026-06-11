import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

type RecentDiscordInboundMessage = {
  accountId: string;
  channelId: string;
  messageId: string;
  at: number;
};

// Best-effort reconnect recovery dedupe: records recent inbound Discord message
// ids that reached the normal message handler, so persisted outbound-anchor
// backfill does not replay already-processed messages after a process restart.
const RECENT_INBOUND_MAX = 2000;
const RECENT_INBOUND_PERSIST_WINDOW_MS = 2 * 60 * 60 * 1000;
const RECENT_INBOUND_STORE_VERSION = 1;
const RECENT_INBOUND_STORE_PATH_ENV = "OPENCLAW_DISCORD_RECENT_INBOUND_STORE_PATH";
const RECENT_INBOUND_DISABLE_PERSISTENCE_ENV =
  "OPENCLAW_DISCORD_RECENT_INBOUND_DISABLE_PERSISTENCE";
const recentInboundByKey = new Map<string, RecentDiscordInboundMessage>();
let persistenceLoadedMaxAgeMs = 0;

function normalize(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

function keyFor(accountId: string, channelId: string, messageId: string) {
  return `${accountId || "default"}:${channelId}:${messageId}`;
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function normalizePersistedEntry(value: unknown): RecentDiscordInboundMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<RecentDiscordInboundMessage>;
  const accountId = normalize(record.accountId) || "default";
  const channelId = normalize(record.channelId);
  const messageId = normalize(record.messageId);
  const at = normalizeTimestamp(record.at);
  if (!channelId || !messageId || at === null) {
    return null;
  }
  return { accountId, channelId, messageId, at };
}

function resolveRecentInboundStorePath(): string | null {
  if (process.env[RECENT_INBOUND_DISABLE_PERSISTENCE_ENV] === "1") {
    return null;
  }
  const override = process.env[RECENT_INBOUND_STORE_PATH_ENV]?.trim();
  if (override) {
    return path.resolve(override);
  }
  // Vitest should not write into a developer's real state dir unless a test
  // explicitly opts in with OPENCLAW_DISCORD_RECENT_INBOUND_STORE_PATH.
  if (process.env.NODE_ENV === "test") {
    return null;
  }
  return path.join(resolveStateDir(process.env), "discord", "recent-inbound.json");
}

function readPersistedRecentInbound(now: number, maxAgeMs: number): RecentDiscordInboundMessage[] {
  const storePath = resolveRecentInboundStorePath();
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
    .filter((entry): entry is RecentDiscordInboundMessage => Boolean(entry))
    .filter((entry) => now - entry.at <= maxAgeMs)
    .toSorted((a, b) => a.at - b.at);
}

function loadPersistedRecentInbound(now: number, maxAgeMs: number) {
  if (persistenceLoadedMaxAgeMs >= maxAgeMs) {
    return;
  }
  persistenceLoadedMaxAgeMs = maxAgeMs;
  for (const entry of readPersistedRecentInbound(now, maxAgeMs)) {
    recentInboundByKey.set(keyFor(entry.accountId, entry.channelId, entry.messageId), entry);
  }
}

function trimRecentInbound(now: number, maxAgeMs: number) {
  for (const [key, entry] of recentInboundByKey) {
    if (now - entry.at > maxAgeMs) {
      recentInboundByKey.delete(key);
    }
  }
  if (recentInboundByKey.size <= RECENT_INBOUND_MAX) {
    return;
  }
  const sorted = [...recentInboundByKey.entries()].toSorted((a, b) => a[1].at - b[1].at);
  for (const [key] of sorted.slice(0, recentInboundByKey.size - RECENT_INBOUND_MAX)) {
    recentInboundByKey.delete(key);
  }
}

function persistRecentInbound(now: number) {
  const storePath = resolveRecentInboundStorePath();
  if (!storePath) {
    return;
  }
  try {
    trimRecentInbound(now, RECENT_INBOUND_PERSIST_WINDOW_MS);
    const entries = [...recentInboundByKey.values()]
      .filter((entry) => now - entry.at <= RECENT_INBOUND_PERSIST_WINDOW_MS)
      .toSorted((a, b) => a.at - b.at);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      tmpPath,
      `${JSON.stringify({ version: RECENT_INBOUND_STORE_VERSION, entries }, null, 2)}\n`,
      "utf8",
    );
    fs.renameSync(tmpPath, storePath);
  } catch {
    // Best-effort resilience cache only. Inbound Discord handling must not fail
    // because this optional replay guard could not be persisted.
  }
}

export function recordRecentDiscordInboundMessage(params: {
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
  loadPersistedRecentInbound(at, RECENT_INBOUND_PERSIST_WINDOW_MS);
  recentInboundByKey.set(keyFor(accountId, channelId, messageId), {
    accountId,
    channelId,
    messageId,
    at,
  });
  trimRecentInbound(at, RECENT_INBOUND_PERSIST_WINDOW_MS);
  persistRecentInbound(at);
}

export function hasRecentDiscordInboundMessage(params: {
  accountId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  maxAgeMs?: number;
  now?: number;
}): boolean {
  const accountId = normalize(params.accountId) || "default";
  const channelId = normalize(params.channelId);
  const messageId = normalize(params.messageId);
  if (!channelId || !messageId) {
    return false;
  }
  const maxAgeMs = params.maxAgeMs ?? RECENT_INBOUND_PERSIST_WINDOW_MS;
  const now = params.now ?? Date.now();
  loadPersistedRecentInbound(now, maxAgeMs);
  trimRecentInbound(now, maxAgeMs);
  return recentInboundByKey.has(keyFor(accountId, channelId, messageId));
}

export function resetRecentDiscordInboundMessagesForTest() {
  recentInboundByKey.clear();
  persistenceLoadedMaxAgeMs = 0;
}

export function clearRecentDiscordInboundPersistenceForTest() {
  const storePath = resolveRecentInboundStorePath();
  if (!storePath) {
    return;
  }
  try {
    fs.rmSync(storePath, { force: true });
  } catch {
    // test helper only
  }
}
