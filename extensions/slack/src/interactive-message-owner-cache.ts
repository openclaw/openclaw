import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const SLACK_INTERACTIVE_MESSAGE_OWNER_CACHE_KEY = Symbol.for(
  "openclaw.slackInteractiveMessageOwner",
);

type SlackInteractiveMessageOwnerRecord = {
  sessionKey: string;
  threadTs?: string;
  expiresAt: number;
};

const ownerCache = resolveGlobalMap<string, SlackInteractiveMessageOwnerRecord>(
  SLACK_INTERACTIVE_MESSAGE_OWNER_CACHE_KEY,
);

function normalizeCacheKeyPart(value: string | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized && normalized.length > 0 ? normalized : null;
}

function buildCacheKey(accountId?: string, channelId?: string, messageTs?: string): string | null {
  const normalizedAccountId = normalizeCacheKeyPart(accountId);
  const normalizedChannelId = normalizeCacheKeyPart(channelId);
  const normalizedMessageTs = normalizeCacheKeyPart(messageTs);
  if (!normalizedAccountId || !normalizedChannelId || !normalizedMessageTs) {
    return null;
  }
  return `${normalizedAccountId}:${normalizedChannelId}:${normalizedMessageTs}`;
}

function evictExpiredEntries(now = Date.now()): void {
  for (const [key, record] of ownerCache.entries()) {
    if (record.expiresAt <= now) {
      ownerCache.delete(key);
    }
  }
}

function enforceMaxEntries(): void {
  const overflow = ownerCache.size - MAX_ENTRIES;
  if (overflow <= 0) {
    return;
  }
  let removed = 0;
  for (const key of ownerCache.keys()) {
    ownerCache.delete(key);
    removed += 1;
    if (removed >= overflow) {
      break;
    }
  }
}

export function recordSlackInteractiveMessageOwner(params: {
  accountId?: string;
  channelId?: string;
  messageTs?: string;
  sessionKey?: string;
  threadTs?: string;
}): void {
  const key = buildCacheKey(params.accountId, params.channelId, params.messageTs);
  const sessionKey = normalizeCacheKeyPart(params.sessionKey);
  if (!key || !sessionKey) {
    return;
  }
  const now = Date.now();
  evictExpiredEntries(now);
  ownerCache.set(key, {
    sessionKey,
    threadTs: normalizeCacheKeyPart(params.threadTs) ?? undefined,
    expiresAt: now + TTL_MS,
  });
  enforceMaxEntries();
}

export function readSlackInteractiveMessageOwner(params: {
  accountId?: string;
  channelId?: string;
  messageTs?: string;
}): { sessionKey: string; threadTs?: string } | undefined {
  const key = buildCacheKey(params.accountId, params.channelId, params.messageTs);
  if (!key) {
    return undefined;
  }
  const record = ownerCache.get(key);
  if (!record) {
    return undefined;
  }
  if (record.expiresAt <= Date.now()) {
    ownerCache.delete(key);
    return undefined;
  }
  return {
    sessionKey: record.sessionKey,
    ...(record.threadTs ? { threadTs: record.threadTs } : {}),
  };
}

export function clearSlackInteractiveMessageOwnerCache(): void {
  ownerCache.clear();
}
