import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { replaceFileAtomicSync } from "openclaw/plugin-sdk/security-runtime";
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
  persistedPath: string;
  store: SentMessageStore;
};

type SentMessageState = {
  bucketsByPath: Map<string, SentMessageBucket>;
};

function getSentMessageState(): SentMessageState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[FEISHU_SENT_MESSAGES_STATE_KEY] as SentMessageState | undefined;
  if (existing) {
    return existing;
  }
  const state: SentMessageState = {
    bucketsByPath: new Map(),
  };
  globalStore[FEISHU_SENT_MESSAGES_STATE_KEY] = state;
  return state;
}

function resolveSentMessageStorePath(cfg?: Pick<OpenClawConfig, "session">): string {
  return `${resolveStorePath(cfg?.session?.store)}.feishu-sent-messages.json`;
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

function readPersistedSentMessages(filePath: string): SentMessageStore {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, SentMessageEntry[]>;
    const now = Date.now();
    const store: SentMessageStore = new Map();
    for (const [key, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      const cleaned = cleanupExpiredEntries(entries, now).slice(-MAX_MESSAGES_PER_SCOPE);
      if (cleaned.length > 0) {
        store.set(key, cleaned);
      }
    }
    return store;
  } catch (error) {
    logVerbose(`feishu: failed to read sent-message cache: ${String(error)}`);
    return new Map();
  }
}

function getSentMessageBucket(cfg?: Pick<OpenClawConfig, "session">): SentMessageBucket {
  const state = getSentMessageState();
  const persistedPath = resolveSentMessageStorePath(cfg);
  const existing = state.bucketsByPath.get(persistedPath);
  if (existing) {
    return existing;
  }
  const bucket = {
    persistedPath,
    store: readPersistedSentMessages(persistedPath),
  };
  state.bucketsByPath.set(persistedPath, bucket);
  return bucket;
}

function persistSentMessages(bucket: SentMessageBucket): void {
  const now = Date.now();
  const serialized: Record<string, SentMessageEntry[]> = {};
  for (const [key, entries] of bucket.store) {
    const cleaned = cleanupExpiredEntries(entries, now).slice(-MAX_MESSAGES_PER_SCOPE);
    if (cleaned.length > 0) {
      serialized[key] = cleaned;
      bucket.store.set(key, cleaned);
    } else {
      bucket.store.delete(key);
    }
  }
  if (Object.keys(serialized).length === 0) {
    fs.rmSync(bucket.persistedPath, { force: true });
    return;
  }
  replaceFileAtomicSync({
    filePath: bucket.persistedPath,
    content: JSON.stringify(serialized),
    tempPrefix: ".feishu-sent-message-cache",
  });
}

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
  try {
    persistSentMessages(bucket);
  } catch (error) {
    logVerbose(`feishu: failed to persist sent-message cache: ${String(error)}`);
  }
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
  try {
    persistSentMessages(bucket);
  } catch (error) {
    logVerbose(`feishu: failed to persist sent-message cache: ${String(error)}`);
  }
}

export function resetFeishuSentMessageCacheForTest(): void {
  getSentMessageState().bucketsByPath.clear();
}
