import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

const TTL_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.telegramSentMessagesState");
const SENT_MESSAGE_STORE = createPluginStateSyncKeyedStore<{
  scopeKey: string;
  chatId: string;
  messageId: string;
  timestamp: number;
}>("telegram", {
  namespace: "sent-messages",
  maxEntries: 100_000,
  defaultTtlMs: TTL_MS,
});

type SentMessageStore = Map<string, Map<string, number>>;

type SentMessageBucket = {
  scopeKey: string;
  store: SentMessageStore;
};

type SentMessageState = {
  bucketsByScope: Map<string, SentMessageBucket>;
};

type SentMessageScopeOptions = {
  accountId?: string | null;
};

function getSentMessageState(): SentMessageState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY] as SentMessageState | undefined;
  if (existing) {
    return existing;
  }
  const state: SentMessageState = {
    bucketsByScope: new Map(),
  };
  globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY] = state;
  return state;
}

function createSentMessageStore(): SentMessageStore {
  return new Map<string, Map<string, number>>();
}

function resolveSentMessageScopeKey(options?: SentMessageScopeOptions): string {
  const accountId = options?.accountId?.trim();
  return accountId || "default";
}

function sentMessageEntryKey(scopeKey: string, chatId: string, messageId: string): string {
  const digest = createHash("sha256")
    .update(`${scopeKey}\0${chatId}\0${messageId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return digest;
}

function cleanupExpired(
  store: SentMessageStore,
  scopeKey: string,
  entry: Map<string, number>,
  now: number,
): void {
  for (const [id, timestamp] of entry) {
    if (now - timestamp > TTL_MS) {
      entry.delete(id);
    }
  }
  if (entry.size === 0) {
    store.delete(scopeKey);
  }
}

function readPersistedSentMessages(scopeKey: string): SentMessageStore {
  const now = Date.now();
  const store = createSentMessageStore();
  for (const entry of SENT_MESSAGE_STORE.entries()) {
    if (entry.value.scopeKey !== scopeKey || now - entry.value.timestamp > TTL_MS) {
      continue;
    }
    let messages = store.get(entry.value.chatId);
    if (!messages) {
      messages = new Map<string, number>();
      store.set(entry.value.chatId, messages);
    }
    messages.set(entry.value.messageId, entry.value.timestamp);
  }
  return store;
}

function getSentMessageBucket(options?: SentMessageScopeOptions): SentMessageBucket {
  const state = getSentMessageState();
  const scopeKey = resolveSentMessageScopeKey(options);
  const existing = state.bucketsByScope.get(scopeKey);
  if (existing) {
    return existing;
  }
  const bucket = {
    scopeKey,
    store: readPersistedSentMessages(scopeKey),
  };
  state.bucketsByScope.set(scopeKey, bucket);
  return bucket;
}

function getSentMessages(options?: SentMessageScopeOptions): SentMessageStore {
  return getSentMessageBucket(options).store;
}

function persistSentMessages(bucket: SentMessageBucket): void {
  const { store, scopeKey } = bucket;
  const now = Date.now();
  for (const [chatId, entry] of store) {
    cleanupExpired(store, chatId, entry, now);
    for (const [messageId, timestamp] of entry) {
      SENT_MESSAGE_STORE.register(
        sentMessageEntryKey(scopeKey, chatId, messageId),
        {
          scopeKey,
          chatId,
          messageId,
          timestamp,
        },
        { ttlMs: TTL_MS },
      );
    }
  }
}

export function recordSentMessage(
  chatId: number | string,
  messageId: number,
  options?: SentMessageScopeOptions,
): void {
  const scopeKey = String(chatId);
  const idKey = String(messageId);
  const now = Date.now();
  const bucket = getSentMessageBucket(options);
  const { store } = bucket;
  let entry = store.get(scopeKey);
  if (!entry) {
    entry = new Map<string, number>();
    store.set(scopeKey, entry);
  }
  entry.set(idKey, now);
  if (entry.size > 100) {
    cleanupExpired(store, scopeKey, entry, now);
  }
  try {
    persistSentMessages(bucket);
  } catch (error) {
    logVerbose(`telegram: failed to persist sent-message cache: ${String(error)}`);
  }
}

export function wasSentByBot(
  chatId: number | string,
  messageId: number,
  options?: SentMessageScopeOptions,
): boolean {
  const scopeKey = String(chatId);
  const idKey = String(messageId);
  const store = getSentMessages(options);
  const entry = store.get(scopeKey);
  if (!entry) {
    return false;
  }
  cleanupExpired(store, scopeKey, entry, Date.now());
  return entry.has(idKey);
}

export function clearSentMessageCache(): void {
  const state = getSentMessageState();
  for (const bucket of state.bucketsByScope.values()) {
    bucket.store.clear();
  }
  state.bucketsByScope.clear();
  SENT_MESSAGE_STORE.clear();
}

export function resetSentMessageCacheForTest(): void {
  getSentMessageState().bucketsByScope.clear();
}
