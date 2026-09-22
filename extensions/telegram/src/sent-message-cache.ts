// Telegram plugin module implements sent message cache behavior.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramRuntime } from "./runtime.js";
import {
  resolveSentMessageScopeKey,
  sentMessageEntryKey,
  TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
  TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
  TTL_MS,
  type PersistedSentMessage,
  type SentMessageConfig,
} from "./sent-message-cache.legacy-state.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const TELEGRAM_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.telegramSentMessagesState");

type SentMessageStore = Map<string, Map<string, number>>;
type SentMessagePersistentStore = PluginStateKeyedStore<PersistedSentMessage>;

type SentMessageBucket = {
  store: SentMessageStore;
  nextCleanupAt: number;
};

type SentMessageState = {
  bucketsByScope: Map<string, Promise<SentMessageBucket>>;
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

function openSentMessageStore(): SentMessagePersistentStore {
  return getTelegramRuntime().state.openKeyedStore<PersistedSentMessage>({
    namespace: TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
    maxEntries: TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
  });
}

function cleanupExpired(
  store: SentMessageStore,
  scopeKey: string,
  entry: Map<string, number>,
  now: number,
): void {
  for (const [id, timestamp] of entry) {
    if (now - timestamp >= TTL_MS) {
      entry.delete(id);
    }
  }
  if (entry.size === 0) {
    store.delete(scopeKey);
  }
}

function cleanupExpiredSentMessages(store: SentMessageStore, now: number): void {
  for (const [scopeKey, entry] of store) {
    cleanupExpired(store, scopeKey, entry, now);
  }
}

async function readPersistedSentMessages(scopeKey: string): Promise<SentMessageStore> {
  const now = Date.now();
  const store = createSentMessageStore();
  try {
    for (const entry of await openSentMessageStore().entries()) {
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
  } catch (error) {
    logVerbose(`telegram: failed to read sent-message cache: ${String(error)}`);
  }
  return store;
}

type SentMessageOwner = { accountId?: string; agentId?: string };

function getSentMessageBucket(scopeKey: string): Promise<SentMessageBucket> {
  const state = getSentMessageState();
  const existing = state.bucketsByScope.get(scopeKey);
  if (existing) {
    return existing;
  }
  const bucket = readPersistedSentMessages(scopeKey).then((store) => ({
    store,
    nextCleanupAt: Date.now() + CLEANUP_INTERVAL_MS,
  }));
  state.bucketsByScope.set(scopeKey, bucket);
  return bucket;
}

async function persistSentMessage(
  scopeKey: string,
  chatId: string,
  messageId: string,
  timestamp: number,
): Promise<void> {
  try {
    await openSentMessageStore().register(
      sentMessageEntryKey(scopeKey, chatId, messageId),
      { scopeKey, chatId, messageId, timestamp },
      { ttlMs: TTL_MS },
    );
  } catch (error) {
    logVerbose(`telegram: failed to persist sent-message cache: ${String(error)}`);
  }
}

export async function recordSentMessage(
  chatId: number | string,
  messageId: number,
  cfg?: SentMessageConfig,
  owner?: SentMessageOwner,
): Promise<void> {
  const scopeKey = String(chatId);
  const idKey = String(messageId);
  const now = Date.now();
  const cacheScopeKey = resolveSentMessageScopeKey(cfg, owner);
  const bucketTask = getSentMessageBucket(cacheScopeKey);
  const persistence = persistSentMessage(cacheScopeKey, scopeKey, idKey, now);
  const bucket = await bucketTask;
  const { store } = bucket;
  let entry = store.get(scopeKey);
  if (!entry) {
    entry = new Map<string, number>();
    store.set(scopeKey, entry);
  }
  entry.set(idKey, now);
  if (now >= bucket.nextCleanupAt) {
    cleanupExpiredSentMessages(store, now);
    bucket.nextCleanupAt = now + CLEANUP_INTERVAL_MS;
  }
  await persistence;
}

export async function wasSentByBot(
  chatId: number | string,
  messageId: number,
  cfg?: SentMessageConfig,
  owner?: SentMessageOwner,
): Promise<boolean> {
  const scopeKey = String(chatId);
  const idKey = String(messageId);
  const { store } = await getSentMessageBucket(resolveSentMessageScopeKey(cfg, owner));
  const entry = store.get(scopeKey);
  if (!entry) {
    return false;
  }
  cleanupExpired(store, scopeKey, entry, Date.now());
  return entry.has(idKey);
}
