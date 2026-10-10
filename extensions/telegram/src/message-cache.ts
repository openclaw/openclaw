import type { Message } from "grammy/types";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTelegramPrimaryMedia } from "./bot/body-helpers.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import {
  compareCachedMessageNodes,
  createTelegramMessageThreadBinding,
  isGroupMessage,
  isTelegramMessageFromCurrentBot,
  mergeCachedMessageNode,
  normalizeMessageNode,
  normalizeMessageNodes,
  parsePersistedCacheValue,
  parseRetainedCacheNode,
  persistedCacheNode,
  resolveReplyMessage,
  retainedMessageId,
  type TelegramCachedMessageNode,
  type TelegramMessageObservationMode,
} from "./message-cache-codec.js";
import {
  isTelegramMessageCacheSourceMessage,
  parseTelegramResolvedMedia,
  type PersistedTelegramMessageCacheValue,
  type TelegramResolvedMedia,
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
} from "./message-cache-persistence.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";
import type { TelegramPromptContextProjection } from "./prompt-context-projection.js";
import { getOptionalTelegramRuntime } from "./runtime.js";

type TelegramConversationContextNode = {
  node: TelegramCachedMessageNode;
  isReplyTarget?: boolean;
};

export type TelegramMessageCache = {
  record: (params: {
    accountId: string;
    chatId: string | number;
    msg: Message;
    botUserId?: number;
    promptContextProjection?: TelegramPromptContextProjection;
    /** Set only while recording an authenticated provider event or response. */
    providerObservedThread?: TelegramThreadSpec;
    threadId?: number;
    historyEligible?: boolean;
  }) => Promise<TelegramCachedMessageNode>;
  recordResolvedMedia: (params: {
    accountId: string;
    botUserId?: number;
    chatId: string | number;
    messageId: string;
    media: TelegramResolvedMedia & { path?: string; fileName?: string };
  }) => Promise<void>;
  get: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
  }) => Promise<TelegramCachedMessageNode | null>;
  recentBefore: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    limit: number;
  }) => Promise<TelegramCachedMessageNode[]>;
  around: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    before: number;
    after: number;
  }) => Promise<TelegramCachedMessageNode[]>;
  /** Reads at most `limit` raw records, before topic and history eligibility filtering. */
  readHistoryWindow: (params: {
    accountId: string;
    chatId: string | number;
    threadId?: number;
    before?: string;
    limit: number;
  }) => Promise<TelegramCachedMessageNode[]>;
  readHistory: (params: {
    accountId: string;
    chatId: string | number;
    threadId?: number;
    before?: string;
    after?: string;
    limit: number;
  }) => Promise<{ messages: TelegramCachedMessageNode[]; hasMore: boolean }>;
};

type TelegramMessageCacheBucket = {
  messages: Map<string, TelegramCachedMessageNode>;
  hydratePromise?: Promise<void>;
  persistentStore?: TelegramMessageCachePersistentStore;
  promoted?: boolean;
  promotePromise?: Promise<void>;
  chatRetention?: Map<string, "bounded" | "retained">;
};

const DEFAULT_MAX_MESSAGES = 5000;
const PERSISTENT_BUCKET_KEY = `plugin-state:${TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE}`;
const TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY = Symbol.for("openclaw.telegram.messageCacheBuckets");

type TelegramMessageCachePersistentStore = {
  register(key: string, value: PersistedTelegramMessageCacheValue): Promise<void>;
  entries(): Promise<Array<{ key: string; value: unknown }>>;
};

type TelegramMessageCacheRetainedStore = Required<
  Pick<
    PluginStateKeyedStore<PersistedTelegramMessageCacheValue>,
    "lookup" | "observe" | "compareAndApply" | "entriesInKeyRange" | "moveEntriesFrom"
  >
>;

const RETAINED_MESSAGE_PAGE_SIZE = 256;
const RETAINED_PROMOTION_BATCH_SIZE = 10_000;

function parseHistoryCursor(cursor: string | undefined): number | undefined {
  const id = parseStrictPositiveInteger(cursor);
  if (cursor !== undefined && (id === undefined || !retainedMessageId(cursor))) {
    throw new Error("Telegram history cursors must be native message IDs");
  }
  return id;
}

function telegramMessageCacheKeyPrefix(params: {
  scopeKey: string | undefined;
  accountId: string;
  chatId: string | number;
}) {
  const prefix = `${params.accountId}:${params.chatId}:`;
  return params.scopeKey ? `${params.scopeKey}:${prefix}` : prefix;
}

function upsertCachedMessageNode(params: {
  messages: Map<string, TelegramCachedMessageNode>;
  key: string;
  node: TelegramCachedMessageNode;
  mode: TelegramMessageObservationMode;
}): TelegramCachedMessageNode {
  const existing = params.messages.get(params.key);
  const node = existing ? mergeCachedMessageNode(existing, params.node, params.mode) : params.node;
  params.messages.delete(params.key);
  params.messages.set(params.key, node);
  return node;
}

function resolveDefaultPersistentStore(): TelegramMessageCachePersistentStore | undefined {
  const runtime = getOptionalTelegramRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    return runtime.state.openKeyedStore<PersistedTelegramMessageCacheValue>({
      namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
    });
  } catch (error) {
    logVerbose(`telegram: failed to open message cache plugin state: ${String(error)}`);
    return undefined;
  }
}

function resolveMessageCacheBucket(params: {
  bucketKey?: string;
  persistentStore?: TelegramMessageCachePersistentStore;
}): TelegramMessageCacheBucket {
  const { bucketKey } = params;
  if (!bucketKey) {
    return {
      messages: new Map<string, TelegramCachedMessageNode>(),
      hydratePromise: Promise.resolve(),
    };
  }
  const persistedMessageCacheBuckets = resolveGlobalMap<string, TelegramMessageCacheBucket>(
    TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY,
  );
  const existing = persistedMessageCacheBuckets.get(bucketKey);
  if (existing) {
    existing.persistentStore = params.persistentStore ?? existing.persistentStore;
    return existing;
  }
  const bucket = {
    messages: new Map<string, TelegramCachedMessageNode>(),
    ...(params.persistentStore ? { persistentStore: params.persistentStore } : {}),
  };
  persistedMessageCacheBuckets.set(bucketKey, bucket);
  return bucket;
}

function hydrateMessageCacheBucket(
  bucket: TelegramMessageCacheBucket,
  maxMessages: number,
  scopeKey?: string,
  excludeGroups = false,
): Promise<void> {
  bucket.hydratePromise ??= (async () => {
    let storeEntries: Array<{ key: string; value: unknown }> = [];
    try {
      storeEntries = (await bucket.persistentStore?.entries()) ?? [];
    } catch (error) {
      logVerbose(`telegram: failed to hydrate message cache from plugin state: ${String(error)}`);
    }
    const scopedStoreEntries = scopeKey
      ? storeEntries.filter(({ key }) => key.startsWith(`${scopeKey}:`))
      : storeEntries;

    for (const { key, value } of scopedStoreEntries) {
      if (
        excludeGroups &&
        isRecord(value) &&
        isTelegramMessageCacheSourceMessage(value.sourceMessage) &&
        isGroupMessage(value.sourceMessage)
      ) {
        bucket.chatRetention?.set(key.slice(0, key.lastIndexOf(":") + 1), "retained");
        continue;
      }
      for (const entry of parsePersistedCacheValue(key, value)) {
        bucket.chatRetention?.set(entry.key.slice(0, entry.key.lastIndexOf(":") + 1), "bounded");
        upsertCachedMessageNode({
          messages: bucket.messages,
          key: entry.key,
          node: entry.node,
          mode: entry.mode,
        });
        pruneMapToMaxSize(bucket.messages, maxMessages);
      }
    }
  })().catch((error: unknown) => {
    bucket.hydratePromise = undefined;
    throw error;
  });
  return bucket.hydratePromise;
}

async function updateRetainedCacheNode(params: {
  store: TelegramMessageCacheRetainedStore;
  key: string;
  botUserId?: number;
  update: (
    existing: TelegramCachedMessageNode | null,
    sawExisting: boolean,
  ) => TelegramCachedMessageNode | null;
}): Promise<TelegramCachedMessageNode | null> {
  let observation = await params.store.observe(params.key);
  let sawExisting = observation.value !== undefined;
  for (;;) {
    const existing = parseRetainedCacheNode(params.key, observation.value);
    const node = params.update(existing, sawExisting);
    if (!node) {
      return null;
    }
    sawExisting ||= existing !== null;
    const result = await params.store.compareAndApply(params.key, observation.comparison, {
      operation: "update",
      action: "set",
      value: persistedCacheNode(node, params.botUserId ?? observation.value?.botUserId),
    });
    if (result.status !== "conflict") {
      return node;
    }
    observation = result.current;
  }
}

export function createTelegramMessageCache(params?: {
  maxMessages?: number;
  scope?: string;
}): TelegramMessageCache {
  const runtime = getOptionalTelegramRuntime();
  const hasRetainedStore = runtime != null;
  const persistentStore = resolveDefaultPersistentStore();
  const maxMessages =
    params?.maxMessages ??
    (persistentStore ? TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES : DEFAULT_MAX_MESSAGES);
  const scopeKey =
    persistentStore || hasRetainedStore
      ? resolveTelegramMessageCachePersistentScopeKey(params?.scope ?? "default")
      : undefined;
  const bucketKey =
    persistentStore || hasRetainedStore ? `${PERSISTENT_BUCKET_KEY}:${scopeKey}` : undefined;
  const bucket = resolveMessageCacheBucket({
    bucketKey,
    ...(persistentStore ? { persistentStore } : {}),
  });
  const { messages } = bucket;
  let retainedStore: TelegramMessageCacheRetainedStore | undefined;
  const chatRetention = (bucket.chatRetention ??= new Map<string, "bounded" | "retained">());

  const openRetainedStore = async (): Promise<TelegramMessageCacheRetainedStore> => {
    if (!retainedStore) {
      const store = runtime?.state.openKeyedStore<PersistedTelegramMessageCacheValue>({
        namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
        retention: "retained",
      });
      if (
        !store?.observe ||
        !store.compareAndApply ||
        !store.entriesInKeyRange ||
        !store.moveEntriesFrom
      ) {
        throw new Error("Telegram group history requires retained plugin-state support");
      }
      retainedStore = {
        lookup: (key) => store.lookup(key),
        observe: store.observe,
        compareAndApply: store.compareAndApply,
        entriesInKeyRange: store.entriesInKeyRange,
        moveEntriesFrom: store.moveEntriesFrom,
      };
    }
    const store = retainedStore;
    if (!bucket.promoted) {
      bucket.promotePromise ??= (async () => {
        if (!persistentStore) {
          throw new Error("Telegram group history cannot open the previous message cache");
        }
        const entries: Array<{ sourceKey: string; targetKey: string }> = [];
        for (const { key, value } of await persistentStore.entries()) {
          const node = parsePersistedCacheValue(key, value).at(-1)?.node;
          const id = node && retainedMessageId(node.messageId);
          if (!node || !id || !isGroupMessage(node.sourceMessage)) {
            continue;
          }
          const suffix = `:${node.sourceMessage.chat.id}:${node.messageId}`;
          if (!key.endsWith(suffix)) {
            continue;
          }
          entries.push({
            sourceKey: key,
            targetKey: `${key.slice(0, key.lastIndexOf(":") + 1)}${id}`,
          });
        }
        for (let offset = 0; offset < entries.length; offset += RETAINED_PROMOTION_BATCH_SIZE) {
          const batch = entries.slice(offset, offset + RETAINED_PROMOTION_BATCH_SIZE);
          await store.moveEntriesFrom({
            namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
            entries: batch,
          });
          for (const { sourceKey } of batch) {
            messages.delete(sourceKey);
          }
        }
        bucket.promoted = true;
      })().finally(() => {
        bucket.promotePromise = undefined;
      });
      await bucket.promotePromise;
    }
    return store;
  };

  const persistCachedNode = async (options: {
    key: string;
    node: TelegramCachedMessageNode;
    botUserId?: number;
  }): Promise<void> => {
    const store = bucket.persistentStore;
    if (!store) {
      return;
    }
    try {
      // A bounded insert may evict legacy group content until namespace promotion settles.
      if (hasRetainedStore && !bucket.promoted) {
        await openRetainedStore();
      }
      await store.register(options.key, persistedCacheNode(options.node, options.botUserId));
    } catch (error) {
      logVerbose(`telegram: failed to persist message cache: ${String(error)}`);
      const marker = options.node.promptContextProjectionMarker;
      if (marker) {
        options.node.promptContextProjectionMarker = {
          kind: "invalid",
          transcriptMessageId:
            marker.kind === "valid"
              ? marker.projection.transcriptMessageId
              : marker.transcriptMessageId,
        };
        throw error;
      }
    }
  };

  const usesRetainedHistory = (accountId: string, chatId: string | number): boolean => {
    if (!hasRetainedStore) {
      return false;
    }
    const prefix = telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId });
    // Native private-chat IDs are positive. A DM read must not acquire group-history availability.
    const retention = chatRetention.get(prefix);
    return retention === "retained" || (retention === undefined && String(chatId).startsWith("-"));
  };

  const get: TelegramMessageCache["get"] = async ({ accountId, chatId, messageId }) => {
    if (!messageId) {
      return null;
    }
    await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey, hasRetainedStore);
    if (usesRetainedHistory(accountId, chatId)) {
      const id = retainedMessageId(messageId);
      if (!id) {
        return null;
      }
      const store = await openRetainedStore();
      const key = `${telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId })}${id}`;
      return parseRetainedCacheNode(key, await store.lookup(key));
    }
    const key = `${telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId })}${messageId}`;
    const entry = messages.get(key);
    if (!entry) {
      return null;
    }
    messages.delete(key);
    messages.set(key, entry);
    return entry;
  };

  const readNodes = async (options: {
    accountId: string;
    chatId: string | number;
    threadId?: number;
    minId?: number;
    maxId?: number;
    limit: number;
    order: "asc" | "desc";
    historyOnly?: boolean;
    scanLimit?: number;
  }): Promise<TelegramCachedMessageNode[]> => {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      return [];
    }
    const normalizedThreadId = parseTelegramMessageThreadId(options.threadId);
    if (options.threadId !== undefined && normalizedThreadId === undefined) {
      return [];
    }
    const thread = normalizedThreadId === undefined ? undefined : String(normalizedThreadId);
    const minId = options.minId ?? 1;
    const maxId = options.maxId ?? 9_999_999_999;
    if (minId > maxId) {
      return [];
    }
    const matches = (node: TelegramCachedMessageNode) =>
      options.historyOnly
        ? node.historyEligible === true && node.threadId === thread
        : thread === undefined || node.threadId === thread;
    const prefix = telegramMessageCacheKeyPrefix({ scopeKey, ...options });
    await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey, hasRetainedStore);
    if (usesRetainedHistory(options.accountId, options.chatId)) {
      const store = await openRetainedStore();
      let keyStartInclusive = `${prefix}${String(minId).padStart(10, "0")}`;
      let keyEndExclusive =
        maxId >= 9_999_999_999 ? `${prefix}~` : `${prefix}${String(maxId + 1).padStart(10, "0")}`;
      const selected: TelegramCachedMessageNode[] = [];
      let remaining = options.scanLimit ?? Number.POSITIVE_INFINITY;
      while (selected.length < options.limit && remaining > 0) {
        const pageLimit = Math.min(RETAINED_MESSAGE_PAGE_SIZE, remaining);
        const page = await store.entriesInKeyRange({
          keyStartInclusive,
          keyEndExclusive,
          limit: pageLimit,
          order: options.order,
        });
        remaining -= page.length;
        for (const { key, value } of page) {
          const node = parseRetainedCacheNode(key, value);
          if (node && matches(node)) {
            selected.push(node);
            if (selected.length === options.limit) {
              break;
            }
          }
        }
        if (page.length < pageLimit || selected.length === options.limit) {
          break;
        }
        const lastKey = page.at(-1)!.key;
        if (options.order === "desc") {
          keyEndExclusive = lastKey;
        } else {
          const nextId = Number(lastKey.slice(prefix.length)) + 1;
          if (!Number.isSafeInteger(nextId) || nextId > maxId) {
            break;
          }
          keyStartInclusive = `${prefix}${String(nextId).padStart(10, "0")}`;
        }
      }
      return selected;
    }
    const selected = Array.from(messages)
      .filter(([key, node]) => {
        const id = parseStrictPositiveInteger(node.messageId);
        return key.startsWith(prefix) && id !== undefined && id >= minId && id <= maxId;
      })
      .map(([, node]) => node)
      .toSorted(compareCachedMessageNodes);
    const ordered = options.order === "asc" ? selected : selected.toReversed();
    return ordered.slice(0, options.scanLimit).filter(matches).slice(0, options.limit);
  };

  return {
    record: async ({
      accountId,
      botUserId,
      chatId,
      msg,
      promptContextProjection,
      providerObservedThread,
      threadId,
      historyEligible,
    }) => {
      const retained = hasRetainedStore && isGroupMessage(msg);
      const store = retained ? await openRetainedStore() : undefined;
      if (!retained) {
        await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey, hasRetainedStore);
      }
      const threadBinding = createTelegramMessageThreadBinding(providerObservedThread);
      const observations = normalizeMessageNodes(msg, {
        threadId,
        historyEligible,
        ...(promptContextProjection && isTelegramMessageFromCurrentBot(msg, botUserId)
          ? {
              promptContextProjectionMarker: { kind: "valid", projection: promptContextProjection },
            }
          : {}),
        ...(threadBinding ? { threadBinding } : {}),
      });
      const currentObservation = observations.at(-1)!;
      const keyPrefix = telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId });
      let recordedEntry = currentObservation.node;
      for (const { node, mode } of observations) {
        const { messageId } = node;
        const id = store ? (retainedMessageId(messageId) ?? "") : messageId;
        if (store && (!id || String(node.sourceMessage.chat?.id) !== String(chatId))) {
          throw new Error("Telegram history requires a native message ID in the owning chat");
        }
        const key = `${keyPrefix}${id}`;
        let cachedNode: TelegramCachedMessageNode | null;
        if (store) {
          cachedNode = await updateRetainedCacheNode({
            store,
            key,
            botUserId,
            update: (existing, sawExisting) => {
              // Embedded snapshots must not resurrect a deleted message.
              if (mode === "partial" && sawExisting && !existing) {
                return null;
              }
              return existing ? mergeCachedMessageNode(existing, node, mode) : node;
            },
          });
          chatRetention.set(keyPrefix, "retained");
        } else {
          chatRetention.set(keyPrefix, "bounded");
          cachedNode = upsertCachedMessageNode({ messages, key, node, mode });
          pruneMapToMaxSize(messages, maxMessages);
          await persistCachedNode({
            key,
            node: cachedNode,
            botUserId,
          });
        }
        if (cachedNode && messageId === currentObservation.node.messageId) {
          recordedEntry = cachedNode;
        }
      }
      return recordedEntry;
    },
    recordResolvedMedia: async ({ accountId, botUserId, chatId, messageId, media }) => {
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey, hasRetainedStore);
      // Runtime downloads carry private paths/names; retain only the persisted media projection.
      const resolvedMedia = parseTelegramResolvedMedia(media);
      if (!resolvedMedia) {
        throw new Error(`Telegram message ${messageId} has invalid resolved media`);
      }
      const withMedia = (node: TelegramCachedMessageNode | null | undefined) => {
        if (!node) {
          throw new Error(`Telegram message ${messageId} was not recorded before media resolution`);
        }
        const fileUniqueId = resolveTelegramPrimaryMedia(node.sourceMessage)?.fileRef
          .file_unique_id;
        if (fileUniqueId !== resolvedMedia.fileUniqueId) {
          throw new Error(`Telegram message ${messageId} media changed during resolution`);
        }
        return { ...node, resolvedMedia };
      };
      if (usesRetainedHistory(accountId, chatId)) {
        const id = retainedMessageId(messageId);
        if (!id) {
          throw new Error("Telegram history requires a native message ID");
        }
        const store = await openRetainedStore();
        const key = `${telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId })}${id}`;
        await updateRetainedCacheNode({ store, key, botUserId, update: withMedia });
        return;
      }
      const key = `${telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId })}${messageId}`;
      const node = withMedia(messages.get(key));
      messages.delete(key);
      messages.set(key, node);
      await persistCachedNode({
        key,
        node,
        botUserId,
      });
    },
    get,
    recentBefore: async ({ accountId, chatId, messageId, threadId, limit }) => {
      const targetId = parseStrictPositiveInteger(messageId);
      return targetId === undefined
        ? []
        : (
            await readNodes({
              accountId,
              chatId,
              threadId,
              maxId: targetId - 1,
              limit,
              order: "desc",
            })
          ).toReversed();
    },
    around: async ({ accountId, chatId, messageId, threadId, before, after }) => {
      const targetId = parseStrictPositiveInteger(messageId);
      if (targetId === undefined) {
        return [];
      }
      const target = await get({ accountId, chatId, messageId });
      const thread = parseTelegramMessageThreadId(threadId);
      if (
        !target ||
        (threadId !== undefined && (thread === undefined || target.threadId !== String(thread)))
      ) {
        return [];
      }
      const [preceding, following] = await Promise.all([
        readNodes({
          accountId,
          chatId,
          threadId,
          maxId: targetId - 1,
          limit: Math.max(0, before),
          order: "desc",
        }),
        readNodes({
          accountId,
          chatId,
          threadId,
          minId: targetId + 1,
          limit: Math.max(0, after),
          order: "asc",
        }),
      ]);
      return [...preceding.toReversed(), target, ...following];
    },
    readHistoryWindow: async ({ accountId, chatId, threadId, before, limit }) => {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        return [];
      }
      const beforeId = parseHistoryCursor(before);
      return (
        await readNodes({
          accountId,
          chatId,
          threadId,
          maxId: beforeId === undefined ? undefined : beforeId - 1,
          limit,
          scanLimit: limit,
          order: "desc",
          historyOnly: true,
        })
      ).toReversed();
    },
    readHistory: async ({ accountId, chatId, threadId, before, after, limit }) => {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit === Number.MAX_SAFE_INTEGER) {
        return { messages: [], hasMore: false };
      }
      const beforeId = parseHistoryCursor(before);
      const afterId = parseHistoryCursor(after);
      const forward = after !== undefined && before === undefined;
      const nodes = await readNodes({
        accountId,
        chatId,
        threadId,
        minId: afterId === undefined ? undefined : afterId + 1,
        maxId: beforeId === undefined ? undefined : beforeId - 1,
        limit: limit + 1,
        order: forward ? "asc" : "desc",
        historyOnly: true,
      });
      const hasMore = nodes.length > limit;
      const selected = nodes.slice(0, limit);
      return { messages: forward ? selected : selected.toReversed(), hasMore };
    },
  };
}

function normalizeSessionBoundaryTimestamp(timestampMs?: number): number | undefined {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
    return undefined;
  }
  return Math.floor(timestampMs / 1000) * 1000;
}

/**
 * Hard cap on reply-chain nodes rendered into the prompt. Model-visible context
 * must be bounded; every producer that appends chain entries shares this ceiling
 * so a busy chat cannot grow the turn past its budget.
 */
export const TELEGRAM_REPLY_CHAIN_MAX_DEPTH = 4;

export async function buildTelegramReplyChain(params: {
  cache: TelegramMessageCache;
  accountId: string;
  chatId: string | number;
  msg: Message;
  maxDepth?: number;
}): Promise<TelegramCachedMessageNode[]> {
  const replyMessage = resolveReplyMessage(params.msg);
  if (!replyMessage?.message_id || String(replyMessage.chat?.id) !== String(params.chatId)) {
    return [];
  }
  const get = (messageId: string) =>
    params.cache.get({ accountId: params.accountId, chatId: params.chatId, messageId });
  const maxDepth = params.maxDepth ?? TELEGRAM_REPLY_CHAIN_MAX_DEPTH;
  const visited = new Set<string>();
  const chain: TelegramCachedMessageNode[] = [];
  let current: TelegramCachedMessageNode | null = await get(String(replyMessage.message_id));
  if (!current && params.msg.reply_to_message) {
    current = normalizeMessageNode(params.msg.reply_to_message, {
      threadId:
        parseTelegramMessageThreadId(params.msg.reply_to_message.message_thread_id) ??
        parseTelegramMessageThreadId(params.msg.message_thread_id),
    });
  }

  while (current?.messageId && chain.length < maxDepth && !visited.has(current.messageId)) {
    visited.add(current.messageId);
    chain.push(current);
    const embeddedReply = current.sourceMessage.reply_to_message;
    if (
      !current.replyToId ||
      chain.length >= maxDepth ||
      visited.has(current.replyToId) ||
      (embeddedReply && String(embeddedReply.chat.id) !== String(params.chatId))
    ) {
      break;
    }
    const storedReply = await get(current.replyToId);
    // Legacy retained roots can contain reply snapshots without separate ancestor rows.
    current =
      storedReply ??
      (embeddedReply && String(embeddedReply.message_id) === current.replyToId
        ? normalizeMessageNode(embeddedReply, {
            threadId:
              parseTelegramMessageThreadId(embeddedReply.message_thread_id) ??
              parseTelegramMessageThreadId(current.threadId),
          })
        : null);
  }

  return chain;
}

export async function buildTelegramConversationContext(params: {
  cache: TelegramMessageCache;
  accountId: string;
  chatId: string | number;
  messageId?: string;
  threadId?: number;
  replyChainNodes: TelegramCachedMessageNode[];
  recentLimit: number;
  replyTargetWindowSize: number;
  minTimestampMs?: number;
}): Promise<TelegramConversationContextNode[]> {
  const selected = new Map<string, TelegramConversationContextNode>();
  const replyTargetIds = new Set<string>();
  const sessionBoundaryTimestamp = normalizeSessionBoundaryTimestamp(params.minTimestampMs);
  const addNode = (node: TelegramCachedMessageNode, replyTarget = false) => {
    if (!node.messageId || node.messageId === params.messageId) {
      return false;
    }
    if (
      sessionBoundaryTimestamp !== undefined &&
      typeof node.timestamp === "number" &&
      Number.isFinite(node.timestamp) &&
      !(node.timestamp >= sessionBoundaryTimestamp)
    ) {
      return false;
    }
    const existing = selected.get(node.messageId);
    selected.set(node.messageId, {
      node: existing?.node ?? node,
      isReplyTarget: existing?.isReplyTarget === true || replyTarget ? true : undefined,
    });
    return true;
  };
  const addReplyTargetWindow = async (messageId: string) => {
    replyTargetIds.add(messageId);
    for (const node of await params.cache.around({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      before: params.replyTargetWindowSize,
      after: params.replyTargetWindowSize,
    })) {
      addNode(node, node.messageId === messageId);
    }
  };

  const currentWindow = await params.cache.recentBefore({
    accountId: params.accountId,
    chatId: params.chatId,
    messageId: params.messageId,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    limit: params.recentLimit,
  });
  for (const node of currentWindow) {
    const added = addNode(node);
    if (added && node.replyToId) {
      await addReplyTargetWindow(node.replyToId);
    }
  }

  for (const [index, node] of params.replyChainNodes.entries()) {
    const added = addNode(node, index === 0);
    if (added && index === 0 && node.messageId) {
      await addReplyTargetWindow(node.messageId);
    }
    if (added && node.replyToId) {
      replyTargetIds.add(node.replyToId);
    }
  }

  for (const messageId of replyTargetIds) {
    const node = await params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId,
    });
    if (node) {
      addNode(node, true);
    }
  }

  return Array.from(selected.values()).toSorted((left, right) =>
    compareCachedMessageNodes(left.node, right.node),
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
