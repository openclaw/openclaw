import { createHash } from "node:crypto";
import type { Message } from "@grammyjs/types";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramPrimaryMedia } from "./bot/body-helpers.js";
import {
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  normalizeForwardedContext,
} from "./bot/helpers.js";

export type TelegramReplyChainEntry = NonNullable<MsgContext["ReplyChain"]>[number];

export type TelegramCachedMessageNode = TelegramReplyChainEntry & {
  sourceMessage: Message;
};

export type TelegramMessageCache = {
  record: (params: {
    accountId: string;
    chatId: string | number;
    msg: Message;
    threadId?: number;
  }) => TelegramCachedMessageNode | null;
  get: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
  }) => TelegramCachedMessageNode | null;
  recentBefore: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    limit: number;
  }) => TelegramCachedMessageNode[];
  around: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    before: number;
    after: number;
  }) => TelegramCachedMessageNode[];
};

type MessageWithExternalReply = Message & { external_reply?: Message };

type TelegramMessageCacheBucket = {
  scopeKey?: string;
  messages: Map<string, TelegramCachedMessageNode>;
};

type TelegramPersistedMessageCacheNode = {
  scopeKey: string;
  cacheKey: string;
  sourceMessage: Message;
  threadId?: string;
};

const DEFAULT_MAX_MESSAGES = 5000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const persistedMessageCacheBuckets = new Map<string, TelegramMessageCacheBucket>();
const MESSAGE_CACHE_STORE = createPluginStateSyncKeyedStore<TelegramPersistedMessageCacheNode>(
  "telegram",
  {
    namespace: "message-cache",
    maxEntries: 100_000,
    defaultTtlMs: DEFAULT_TTL_MS,
  },
);

function telegramMessageCacheKey(params: {
  accountId: string;
  chatId: string | number;
  messageId: string;
}) {
  return `${params.accountId}:${params.chatId}:${params.messageId}`;
}

function telegramMessageCacheKeyPrefix(params: { accountId: string; chatId: string | number }) {
  return `${params.accountId}:${params.chatId}:`;
}

export function resolveTelegramMessageCacheScopeKey(scopeSeed: string): string {
  const trimmed = scopeSeed.trim();
  return trimmed ? `telegram-message-cache:${trimmed}` : "telegram-message-cache:default";
}

function resolveReplyMessage(msg: Message): Message | undefined {
  const externalReply = (msg as MessageWithExternalReply).external_reply;
  return msg.reply_to_message ?? externalReply;
}

function resolveMessageBody(msg: Message): string | undefined {
  const text = getTelegramTextParts(msg).text.trim();
  if (text) {
    return text;
  }
  const location = extractTelegramLocation(msg);
  if (location) {
    return formatLocationText(location);
  }
  return resolveTelegramPrimaryMedia(msg)?.placeholder;
}

function resolveMediaType(placeholder?: string): string | undefined {
  return placeholder?.match(/^<media:([^>]+)>$/)?.[1];
}

function normalizeMessageNode(
  msg: Message,
  params: { threadId?: number },
): TelegramCachedMessageNode | null {
  if (typeof msg.message_id !== "number") {
    return null;
  }
  const media = resolveTelegramPrimaryMedia(msg);
  const fileId = media?.fileRef.file_id;
  const forwardedFrom = normalizeForwardedContext(msg);
  const replyMessage = resolveReplyMessage(msg);
  const body = resolveMessageBody(msg);
  return {
    sourceMessage: msg,
    messageId: String(msg.message_id),
    sender: buildSenderName(msg) ?? "unknown sender",
    ...(msg.from?.id != null ? { senderId: String(msg.from.id) } : {}),
    ...(msg.from?.username ? { senderUsername: msg.from.username } : {}),
    ...(msg.date ? { timestamp: msg.date * 1000 } : {}),
    ...(body ? { body } : {}),
    ...(media ? { mediaType: resolveMediaType(media.placeholder) ?? media.placeholder } : {}),
    ...(fileId ? { mediaRef: `telegram:file/${fileId}` } : {}),
    ...(replyMessage?.message_id != null ? { replyToId: String(replyMessage.message_id) } : {}),
    ...(forwardedFrom?.from ? { forwardedFrom: forwardedFrom.from } : {}),
    ...(forwardedFrom?.fromId ? { forwardedFromId: forwardedFrom.fromId } : {}),
    ...(forwardedFrom?.fromUsername ? { forwardedFromUsername: forwardedFrom.fromUsername } : {}),
    ...(forwardedFrom?.date ? { forwardedDate: forwardedFrom.date * 1000 } : {}),
    ...(params.threadId != null ? { threadId: String(params.threadId) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return isString(value) ? value : undefined;
}

function isTelegramSourceMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.message_id === "number" &&
    Number.isFinite(value.message_id) &&
    typeof value.date === "number" &&
    Number.isFinite(value.date)
  );
}

function parsePersistedNode(value: unknown): TelegramCachedMessageNode | null {
  if (!isRecord(value) || !isTelegramSourceMessage(value.sourceMessage)) {
    return null;
  }
  const threadId = Number(readOptionalString(value, "threadId"));
  return normalizeMessageNode(value.sourceMessage, Number.isFinite(threadId) ? { threadId } : {});
}

function trimMessages(messages: Map<string, TelegramCachedMessageNode>, maxMessages: number): void {
  while (messages.size > maxMessages) {
    const oldest = messages.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    messages.delete(oldest);
  }
}

function persistedMessageEntryKey(scopeKey: string, cacheKey: string): string {
  return createHash("sha256").update(`${scopeKey}\0${cacheKey}`, "utf8").digest("hex").slice(0, 32);
}

function readPersistedMessages(scopeKey: string, maxMessages: number) {
  const messages = new Map<string, TelegramCachedMessageNode>();
  try {
    for (const entry of MESSAGE_CACHE_STORE.entries()
      .filter((entry) => entry.value.scopeKey === scopeKey)
      .slice(-maxMessages)) {
      if (!isString(entry.value.cacheKey)) {
        continue;
      }
      const node = parsePersistedNode(entry.value);
      if (node) {
        messages.set(entry.value.cacheKey, node);
      }
    }
  } catch (error) {
    logVerbose(`telegram: failed to read message cache: ${String(error)}`);
  }
  return messages;
}

function persistMessages(params: {
  messages: Map<string, TelegramCachedMessageNode>;
  scopeKey?: string;
}) {
  const { scopeKey, messages } = params;
  if (!scopeKey) {
    return;
  }
  const retained = new Set(messages.keys());
  for (const entry of MESSAGE_CACHE_STORE.entries()) {
    if (entry.value.scopeKey === scopeKey && !retained.has(entry.value.cacheKey)) {
      MESSAGE_CACHE_STORE.delete(entry.key);
    }
  }
  for (const [key, node] of messages) {
    MESSAGE_CACHE_STORE.register(
      persistedMessageEntryKey(scopeKey, key),
      {
        scopeKey,
        cacheKey: key,
        sourceMessage: node.sourceMessage,
        ...(node.threadId ? { threadId: node.threadId } : {}),
      },
      { ttlMs: DEFAULT_TTL_MS },
    );
  }
}

export function importTelegramMessageCacheEntries(scopeKey: string, entries: unknown): number {
  if (!Array.isArray(entries)) {
    return 0;
  }
  let imported = 0;
  const bucket = persistedMessageCacheBuckets.get(scopeKey);
  for (const entry of entries) {
    if (!isRecord(entry) || !isString(entry.key)) {
      continue;
    }
    const node = parsePersistedNode(entry.node);
    if (!node) {
      continue;
    }
    MESSAGE_CACHE_STORE.register(
      persistedMessageEntryKey(scopeKey, entry.key),
      {
        scopeKey,
        cacheKey: entry.key,
        sourceMessage: node.sourceMessage,
        ...(node.threadId ? { threadId: node.threadId } : {}),
      },
      { ttlMs: DEFAULT_TTL_MS },
    );
    bucket?.messages.set(entry.key, node);
    imported += 1;
  }
  return imported;
}

function resolveMessageCacheBucket(params: {
  scopeKey?: string;
  maxMessages: number;
}): TelegramMessageCacheBucket {
  const { scopeKey, maxMessages } = params;
  if (!scopeKey) {
    return { messages: new Map<string, TelegramCachedMessageNode>() };
  }
  const existing = persistedMessageCacheBuckets.get(scopeKey);
  if (existing) {
    return existing;
  }
  const bucket = {
    scopeKey,
    messages: readPersistedMessages(scopeKey, maxMessages),
  };
  persistedMessageCacheBuckets.set(scopeKey, bucket);
  return bucket;
}

export function createTelegramMessageCache(params?: {
  maxMessages?: number;
  persistedScopeKey?: string;
}): TelegramMessageCache {
  const maxMessages = params?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const scopeKey = params?.persistedScopeKey;
  const { messages } = resolveMessageCacheBucket({
    scopeKey,
    maxMessages,
  });

  const get: TelegramMessageCache["get"] = ({ accountId, chatId, messageId }) => {
    if (!messageId) {
      return null;
    }
    const key = telegramMessageCacheKey({ accountId, chatId, messageId });
    const entry = messages.get(key);
    if (!entry) {
      return null;
    }
    messages.delete(key);
    messages.set(key, entry);
    return entry;
  };

  const listChatMessages = (params: {
    accountId: string;
    chatId: string | number;
    threadId?: number;
  }) => {
    const prefix = telegramMessageCacheKeyPrefix(params);
    const threadId = params.threadId != null ? String(params.threadId) : undefined;
    return Array.from(messages, ([key, node]) => ({ key, node }))
      .filter(({ key, node }) => {
        if (!key.startsWith(prefix)) {
          return false;
        }
        return threadId === undefined || node.threadId === threadId;
      })
      .map(({ node }) => node)
      .toSorted(compareCachedMessageNodes);
  };

  return {
    record: ({ accountId, chatId, msg, threadId }) => {
      const entry = normalizeMessageNode(msg, { threadId });
      if (!entry?.messageId) {
        return null;
      }
      const key = telegramMessageCacheKey({ accountId, chatId, messageId: entry.messageId });
      messages.delete(key);
      messages.set(key, entry);
      trimMessages(messages, maxMessages);
      try {
        persistMessages({ messages, scopeKey });
      } catch (error) {
        logVerbose(`telegram: failed to persist message cache: ${String(error)}`);
      }
      return entry;
    },
    get,
    recentBefore: ({ accountId, chatId, messageId, threadId, limit }) => {
      if (!messageId || limit <= 0) {
        return [];
      }
      const targetId = Number(messageId);
      if (!Number.isFinite(targetId)) {
        return [];
      }
      return listChatMessages({ accountId, chatId, threadId })
        .filter((entry) => {
          const entryId = Number(entry.messageId);
          return Number.isFinite(entryId) && entryId < targetId;
        })
        .slice(-limit);
    },
    around: ({ accountId, chatId, messageId, threadId, before, after }) => {
      if (!messageId) {
        return [];
      }
      const entries = listChatMessages({ accountId, chatId, threadId });
      const targetIndex = entries.findIndex((entry) => entry.messageId === messageId);
      if (targetIndex === -1) {
        return [];
      }
      return entries.slice(
        Math.max(0, targetIndex - Math.max(0, before)),
        targetIndex + Math.max(0, after) + 1,
      );
    },
  };
}

function compareCachedMessageNodes(
  left: TelegramCachedMessageNode,
  right: TelegramCachedMessageNode,
) {
  const leftId = Number(left.messageId);
  const rightId = Number(right.messageId);
  if (Number.isFinite(leftId) && Number.isFinite(rightId)) {
    return leftId - rightId;
  }
  return (left.messageId ?? "").localeCompare(right.messageId ?? "");
}

export function buildTelegramReplyChain(params: {
  cache: TelegramMessageCache;
  accountId: string;
  chatId: string | number;
  msg: Message;
  maxDepth?: number;
}): TelegramCachedMessageNode[] {
  const replyMessage = resolveReplyMessage(params.msg);
  if (!replyMessage?.message_id) {
    return [];
  }
  const maxDepth = params.maxDepth ?? 4;
  const visited = new Set<string>();
  const chain: TelegramCachedMessageNode[] = [];
  let current =
    params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: String(replyMessage.message_id),
    }) ?? normalizeMessageNode(replyMessage, {});

  while (current?.messageId && chain.length < maxDepth && !visited.has(current.messageId)) {
    visited.add(current.messageId);
    chain.push(current);
    current = params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: current.replyToId,
    });
  }

  return chain;
}
