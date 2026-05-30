import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_SCOPE = 100;
const FEISHU_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.feishuSentMessagesState");

type SentMessageEntry = {
  messageId: string;
  timestamp: number;
};

type SentMessageStore = Map<string, SentMessageEntry[]>;

type SentMessageBucket = {
  storeKey: string;
  store: SentMessageStore;
};

type SentMessageState = {
  bucketsByKey: Map<string, SentMessageBucket>;
};

function getSentMessageState(): SentMessageState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[FEISHU_SENT_MESSAGES_STATE_KEY] as SentMessageState | undefined;
  if (existing) {
    return existing;
  }
  const state: SentMessageState = {
    bucketsByKey: new Map(),
  };
  globalStore[FEISHU_SENT_MESSAGES_STATE_KEY] = state;
  return state;
}

function resolveSentMessageStoreKey(cfg?: Pick<OpenClawConfig, "session">): string {
  return resolveStorePath(cfg?.session?.store);
}

function scopeKey(params: { accountId?: string | null; chatId: string }): string {
  return `${params.accountId?.trim() || "default"}:${params.chatId}`;
}

function cleanupExpiredEntries(entries: SentMessageEntry[], now: number): SentMessageEntry[] {
  return entries.filter(
    (entry) =>
      entry.messageId.trim().length > 0 &&
      Number.isFinite(entry.timestamp) &&
      now - entry.timestamp <= TTL_MS,
  );
}

function getSentMessageBucket(cfg?: Pick<OpenClawConfig, "session">): SentMessageBucket {
  const state = getSentMessageState();
  const storeKey = resolveSentMessageStoreKey(cfg);
  const existing = state.bucketsByKey.get(storeKey);
  if (existing) {
    return existing;
  }
  const bucket = {
    storeKey,
    store: new Map(),
  };
  state.bucketsByKey.set(storeKey, bucket);
  return bucket;
}

// Intentionally process-local. Message IDs are sensitive message-management
// state, so ordinary Feishu sends must not persist this fallback cache to disk.
export function recordFeishuSentMessage(params: {
  cfg?: Pick<OpenClawConfig, "session">;
  accountId?: string | null;
  chatId?: string;
  messageId?: string;
}): void {
  const chatId = params.chatId?.trim();
  const messageId = params.messageId?.trim();
  if (!chatId || !messageId || messageId === "unknown") {
    return;
  }
  const bucket = getSentMessageBucket(params.cfg);
  const key = scopeKey({ accountId: params.accountId, chatId });
  const now = Date.now();
  const entries = cleanupExpiredEntries(bucket.store.get(key) ?? [], now).filter(
    (entry) => entry.messageId !== messageId,
  );
  entries.push({ messageId, timestamp: now });
  bucket.store.set(key, entries.slice(-MAX_MESSAGES_PER_SCOPE));
}

export function getLastFeishuSentMessage(params: {
  cfg?: Pick<OpenClawConfig, "session">;
  accountId?: string | null;
  chatId?: string;
}): string | undefined {
  const chatId = params.chatId?.trim();
  if (!chatId) {
    return undefined;
  }
  const bucket = getSentMessageBucket(params.cfg);
  const key = scopeKey({ accountId: params.accountId, chatId });
  const entries = cleanupExpiredEntries(bucket.store.get(key) ?? [], Date.now()).slice(
    -MAX_MESSAGES_PER_SCOPE,
  );
  if (entries.length === 0) {
    bucket.store.delete(key);
    return undefined;
  }
  bucket.store.set(key, entries);
  return entries.at(-1)?.messageId;
}

export function forgetFeishuSentMessage(params: {
  cfg?: Pick<OpenClawConfig, "session">;
  accountId?: string | null;
  chatId?: string;
  messageId?: string;
}): void {
  const chatId = params.chatId?.trim();
  const messageId = params.messageId?.trim();
  if (!chatId || !messageId) {
    return;
  }
  const bucket = getSentMessageBucket(params.cfg);
  const key = scopeKey({ accountId: params.accountId, chatId });
  const entries = (bucket.store.get(key) ?? []).filter((entry) => entry.messageId !== messageId);
  if (entries.length > 0) {
    bucket.store.set(key, entries);
  } else {
    bucket.store.delete(key);
  }
}

export function resetFeishuSentMessageCacheForTest(): void {
  getSentMessageState().bucketsByKey.clear();
}
