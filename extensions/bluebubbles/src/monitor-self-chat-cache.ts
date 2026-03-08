import { createHash } from "node:crypto";

type SelfChatCacheKeyParts = {
  accountId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  senderId: string;
};

type SelfChatLookup = SelfChatCacheKeyParts & {
  body?: string;
  timestamp?: number;
};

const SELF_CHAT_TTL_MS = 10_000;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1_000;
const cache = new Map<string, number>();
let lastCleanupAt = 0;

function normalizeBody(body: string | undefined): string | null {
  if (!body) {
    return null;
  }
  const normalized = body.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}

function isUsableTimestamp(timestamp: number | undefined): timestamp is number {
  return typeof timestamp === "number" && Number.isFinite(timestamp);
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

function trimOrUndefined(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildScope(parts: SelfChatCacheKeyParts): string {
  const target =
    trimOrUndefined(parts.chatGuid) ??
    trimOrUndefined(parts.chatIdentifier) ??
    (typeof parts.chatId === "number" ? String(parts.chatId) : null) ??
    parts.senderId;
  return `${parts.accountId}:${target}`;
}

function maybeCleanup(now = Date.now()): void {
  if (lastCleanupAt !== 0 && now - lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) {
    return;
  }
  lastCleanupAt = now;
  for (const [key, seenAt] of cache.entries()) {
    if (now - seenAt > SELF_CHAT_TTL_MS) {
      cache.delete(key);
    }
  }
  while (cache.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    cache.delete(oldestKey);
  }
}

function buildKey(lookup: SelfChatLookup): string | null {
  const body = normalizeBody(lookup.body);
  if (!body || !isUsableTimestamp(lookup.timestamp)) {
    return null;
  }
  return `${buildScope(lookup)}:${lookup.timestamp}:${digestText(body)}`;
}

export function rememberBlueBubblesSelfChatCopy(lookup: SelfChatLookup): void {
  maybeCleanup();
  const key = buildKey(lookup);
  if (!key) {
    return;
  }
  cache.set(key, Date.now());
  maybeCleanup();
}

export function hasBlueBubblesSelfChatCopy(lookup: SelfChatLookup): boolean {
  maybeCleanup();
  const key = buildKey(lookup);
  if (!key) {
    return false;
  }
  const seenAt = cache.get(key);
  return typeof seenAt === "number" && Date.now() - seenAt <= SELF_CHAT_TTL_MS;
}

export function resetBlueBubblesSelfChatCache(): void {
  cache.clear();
  lastCleanupAt = 0;
}
