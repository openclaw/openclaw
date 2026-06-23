// Feishu plugin module implements monitor.message handler behavior.
import { isRecord, readStringValue as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, HistoryEntry, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { resolveConfiguredFeishuGroupSessionScope } from "./bot-content.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { isMentionForwardRequest } from "./mention.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import {
  releaseFeishuMessageProcessing,
  tryBeginFeishuMessageProcessing,
} from "./processing-claims.js";
import { createSequentialQueue } from "./sequential-queue.js";
import type { FeishuChatType, FeishuMessageInfo } from "./types.js";

type FeishuMessageFetcher = (params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}) => Promise<FeishuMessageInfo | null>;

type FeishuMessageReceiveHandlerContext = {
  cfg: ClawdbotConfig;
  channelRuntime: PluginRuntime["channel"];
  accountId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
  handleMessage: (params: {
    cfg: ClawdbotConfig;
    event: FeishuMessageEvent;
    botOpenId?: string;
    botName?: string;
    runtime?: RuntimeEnv;
    channelRuntime?: PluginRuntime["channel"];
    chatHistories?: Map<string, HistoryEntry[]>;
    accountId?: string;
    processingClaimHeld?: boolean;
    messageDedupeKey?: string;
  }) => Promise<void>;
  resolveDebounceText: (params: {
    event: FeishuMessageEvent;
    botOpenId?: string;
    botName?: string;
  }) => string;
  hasProcessedMessage: (
    messageId: string | undefined | null,
    namespace: string,
    log?: (...args: unknown[]) => void,
  ) => Promise<boolean>;
  recordProcessedMessage: (
    messageId: string | undefined | null,
    namespace: string,
    log?: (...args: unknown[]) => void,
  ) => Promise<boolean>;
  getBotOpenId?: (accountId: string) => string | undefined;
  getBotName?: (accountId: string) => string | undefined;
  fetchMessage?: FeishuMessageFetcher;
  resolveSequentialKey?: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
    event: FeishuMessageEvent;
    botOpenId?: string;
    botName?: string;
  }) => string;
};

function normalizeFeishuChatType(value: unknown): FeishuChatType | undefined {
  return value === "group" || value === "topic_group" || value === "private" || value === "p2p"
    ? value
    : undefined;
}

function resolveFeishuProcessingClaimKey(params: {
  event: FeishuMessageEvent;
  messageDedupeKey?: string;
}): string | undefined {
  const messageId = params.event.message.message_id?.trim();
  return params.messageDedupeKey && params.messageDedupeKey !== messageId
    ? params.messageDedupeKey
    : messageId;
}

function isFeishuTopicSessionScope(scope: string): boolean {
  return scope === "group_topic" || scope === "group_topic_sender";
}

function shouldHydrateFeishuTopicThreadIdForQueue(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  event: FeishuMessageEvent;
}): boolean {
  if (params.event.message.chat_type !== "topic_group" || params.event.message.thread_id?.trim()) {
    return false;
  }
  const chatId = params.event.message.chat_id?.trim();
  if (!chatId) {
    return false;
  }
  const feishuCfg = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId }).config;
  const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId });
  return isFeishuTopicSessionScope(
    resolveConfiguredFeishuGroupSessionScope({
      groupConfig,
      feishuCfg,
      chatType: params.event.message.chat_type,
    }),
  );
}

function buildPendingTopicChatKey(event: FeishuMessageEvent): string | null {
  if (event.message.chat_type !== "topic_group") {
    return null;
  }
  return event.message.chat_id?.trim() || null;
}

async function hydrateFeishuTopicThreadIdForQueue(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  event: FeishuMessageEvent;
  fetchMessage?: FeishuMessageFetcher;
  log: (...args: unknown[]) => void;
}): Promise<FeishuMessageEvent> {
  if (
    !params.fetchMessage ||
    !shouldHydrateFeishuTopicThreadIdForQueue({
      cfg: params.cfg,
      accountId: params.accountId,
      event: params.event,
    })
  ) {
    return params.event;
  }
  try {
    const messageInfo = await params.fetchMessage({
      cfg: params.cfg,
      accountId: params.accountId,
      messageId: params.event.message.message_id,
    });
    const threadId = messageInfo?.threadId?.trim();
    if (threadId) {
      return {
        ...params.event,
        message: {
          ...params.event.message,
          thread_id: threadId,
        },
      };
    }
  } catch (err) {
    params.log(
      `feishu[${params.accountId}]: failed to hydrate topic thread_id before queueing message=${params.event.message.message_id}: ${String(err)}`,
    );
  }
  return params.event;
}

function parseFeishuMessageEventPayload(value: unknown): FeishuMessageEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const sender = value.sender;
  const message = value.message;
  if (!isRecord(sender) || !isRecord(message)) {
    return null;
  }
  const senderId = sender.sender_id;
  if (!isRecord(senderId)) {
    return null;
  }
  const messageId = readString(message.message_id);
  const chatId = readString(message.chat_id);
  const chatType = normalizeFeishuChatType(message.chat_type);
  const messageType = readString(message.message_type);
  const content = readString(message.content);
  if (!messageId || !chatId || !chatType || !messageType || !content) {
    return null;
  }
  return value as FeishuMessageEvent;
}

function mergeFeishuDebounceMentions(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent["message"]["mentions"] | undefined {
  const merged = new Map<string, NonNullable<FeishuMessageEvent["message"]["mentions"]>[number]>();
  for (const entry of entries) {
    for (const mention of entry.message.mentions ?? []) {
      const stableId =
        mention.id.open_id?.trim() || mention.id.user_id?.trim() || mention.id.union_id?.trim();
      const mentionName = mention.name?.trim();
      const mentionKey = mention.key?.trim();
      const fallback =
        mentionName && mentionKey ? `${mentionName}|${mentionKey}` : mentionName || mentionKey;
      const key = stableId || fallback;
      if (!key || merged.has(key)) {
        continue;
      }
      merged.set(key, mention);
    }
  }
  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

function dedupeFeishuDebounceEntriesByDedupeKey(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent[] {
  const seen = new Set<string>();
  const deduped: FeishuMessageEvent[] = [];
  for (const entry of entries) {
    const dedupeKey = resolveFeishuMessageDedupeKey(entry);
    if (!dedupeKey) {
      deduped.push(entry);
      continue;
    }
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    deduped.push(entry);
  }
  return deduped;
}

function resolveFeishuDebounceMentions(params: {
  entries: FeishuMessageEvent[];
  botOpenId?: string;
}): FeishuMessageEvent["message"]["mentions"] | undefined {
  const { entries, botOpenId } = params;
  if (entries.length === 0) {
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isMentionForwardRequest(entry, botOpenId)) {
      return mergeFeishuDebounceMentions([entry]);
    }
  }
  const merged = mergeFeishuDebounceMentions(entries);
  if (!merged) {
    return undefined;
  }
  const normalizedBotOpenId = botOpenId?.trim();
  if (!normalizedBotOpenId) {
    return undefined;
  }
  const botMentions = merged.filter(
    (mention) => mention.id.open_id?.trim() === normalizedBotOpenId,
  );
  return botMentions.length > 0 ? botMentions : undefined;
}

export function createFeishuMessageReceiveHandler({
  cfg,
  channelRuntime,
  accountId,
  runtime,
  chatHistories,
  fireAndForget,
  handleMessage,
  resolveDebounceText: resolveText,
  hasProcessedMessage,
  recordProcessedMessage,
  getBotOpenId = () => undefined,
  getBotName = () => undefined,
  fetchMessage,
  resolveSequentialKey = ({ accountId: accountIdLocal, event }) =>
    `feishu:${accountIdLocal}:${event.message.chat_id?.trim() || "unknown"}`,
}: FeishuMessageReceiveHandlerContext): (data: unknown) => Promise<void> {
  const inboundDebounceMs = channelRuntime.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "feishu",
  });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const enqueue = createSequentialQueue({
    onTaskTimeout: (key, timeoutMs) => {
      log(
        `feishu[${accountId}]: per-conversation task exceeded ${timeoutMs}ms cap (key=${key}); evicting from queue so later same-key messages can proceed (#70133)`,
      );
    },
  });
  const pendingTopicQueueingByChat = new Map<string, Promise<void>>();

  const startFeishuMessageQueueTask = (
    queueEvent: FeishuMessageEvent,
    messageDedupeKey?: string,
  ): Promise<void> => {
    const sequentialKey = resolveSequentialKey({
      cfg,
      accountId,
      event: queueEvent,
      botOpenId: getBotOpenId(accountId),
      botName: getBotName(accountId),
    });
    const task = () =>
      handleMessage({
        cfg,
        event: queueEvent,
        botOpenId: getBotOpenId(accountId),
        botName: getBotName(accountId),
        runtime,
        channelRuntime,
        chatHistories,
        accountId,
        processingClaimHeld: true,
        messageDedupeKey,
      });
    return enqueue(sequentialKey, task);
  };

  const hydrateAndStartFeishuMessageQueueTask = async (
    event: FeishuMessageEvent,
    messageDedupeKey?: string,
  ): Promise<void> => {
    const queueEvent = await hydrateFeishuTopicThreadIdForQueue({
      cfg,
      accountId,
      event,
      fetchMessage,
      log,
    });
    await startFeishuMessageQueueTask(queueEvent, messageDedupeKey);
  };

  const waitForPendingTopicQueueing = async (event: FeishuMessageEvent): Promise<void> => {
    const chatKey = buildPendingTopicChatKey(event);
    const pendingQueueing = chatKey ? pendingTopicQueueingByChat.get(chatKey) : undefined;
    if (!pendingQueueing) {
      return;
    }
    await pendingQueueing.catch(() => undefined);
  };

  const dispatchFeishuMessage = async (event: FeishuMessageEvent, messageDedupeKey?: string) => {
    const shouldTrackTopicQueueing =
      event.message.chat_type === "topic_group" && !event.message.thread_id?.trim();
    if (shouldTrackTopicQueueing) {
      const chatKey = buildPendingTopicChatKey(event);
      const previousQueueing =
        (chatKey ? pendingTopicQueueingByChat.get(chatKey) : undefined) ?? Promise.resolve();
      let taskPromise: Promise<void> | undefined;
      const queueingPromise = previousQueueing
        .catch(() => undefined)
        .then(async () => {
          const queueEvent = await hydrateFeishuTopicThreadIdForQueue({
            cfg,
            accountId,
            event,
            fetchMessage,
            log,
          });
          taskPromise = startFeishuMessageQueueTask(queueEvent, messageDedupeKey);
        });
      if (chatKey) {
        pendingTopicQueueingByChat.set(chatKey, queueingPromise);
      }
      try {
        await queueingPromise;
      } finally {
        if (chatKey && pendingTopicQueueingByChat.get(chatKey) === queueingPromise) {
          pendingTopicQueueingByChat.delete(chatKey);
        }
      }
      try {
        await taskPromise;
      } finally {
        taskPromise = undefined;
      }
      return;
    }

    await waitForPendingTopicQueueing(event);
    await hydrateAndStartFeishuMessageQueueTask(event, messageDedupeKey);
  };

  const resolveSenderDebounceId = (event: FeishuMessageEvent): string | undefined => {
    const senderId =
      event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim();
    return senderId || undefined;
  };

  const resolveDebounceText = (event: FeishuMessageEvent): string => {
    return resolveText({
      event,
      botOpenId: getBotOpenId(accountId),
      botName: getBotName(accountId),
    }).trim();
  };

  const recordSuppressedMessageIds = async (
    entries: FeishuMessageEvent[],
    dispatchDedupeKey?: string,
  ) => {
    const keepDedupeKey = dispatchDedupeKey?.trim();
    const suppressedIds = new Set(
      entries
        .map((entry) => resolveFeishuMessageDedupeKey(entry))
        .filter((id): id is string => Boolean(id) && (!keepDedupeKey || id !== keepDedupeKey)),
    );
    for (const messageId of suppressedIds) {
      try {
        await recordProcessedMessage(messageId, accountId, log);
      } catch (err) {
        error(
          `feishu[${accountId}]: failed to record merged dedupe id ${messageId}: ${String(err)}`,
        );
      }
    }
  };

  const inboundDebouncer = channelRuntime.debounce.createInboundDebouncer<FeishuMessageEvent>({
    debounceMs: inboundDebounceMs,
    buildKey: (event) => {
      const chatId = event.message.chat_id?.trim();
      const senderId = resolveSenderDebounceId(event);
      if (!chatId || !senderId) {
        return null;
      }
      const rootId = event.message.root_id?.trim();
      const threadId = event.message.thread_id?.trim();
      const threadKey = threadId || rootId ? `thread:${threadId ?? rootId}` : "chat";
      return `feishu:${accountId}:${chatId}:${threadKey}:${senderId}`;
    },
    shouldDebounce: (event) => {
      if (event.message.message_type !== "text") {
        return false;
      }
      const text = resolveDebounceText(event);
      return Boolean(text) && !channelRuntime.commands.isControlCommandMessage(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await dispatchFeishuMessage(last, resolveFeishuMessageDedupeKey(last));
        return;
      }
      const dedupedEntries = dedupeFeishuDebounceEntriesByDedupeKey(entries);
      const freshEntries: FeishuMessageEvent[] = [];
      for (const entry of dedupedEntries) {
        if (!(await hasProcessedMessage(resolveFeishuMessageDedupeKey(entry), accountId, log))) {
          freshEntries.push(entry);
        }
      }
      const dispatchEntry = freshEntries.at(-1);
      if (!dispatchEntry) {
        return;
      }
      const dispatchDedupeKey = resolveFeishuMessageDedupeKey(dispatchEntry);
      await recordSuppressedMessageIds(dedupedEntries, dispatchDedupeKey);
      const combinedText = freshEntries
        .map((entry) => resolveDebounceText(entry))
        .filter(Boolean)
        .join("\n");
      const mergedMentions = resolveFeishuDebounceMentions({
        entries: freshEntries,
        botOpenId: getBotOpenId(accountId),
      });
      await dispatchFeishuMessage(
        {
          ...dispatchEntry,
          message: {
            ...dispatchEntry.message,
            ...(combinedText.trim()
              ? {
                  message_type: "text",
                  content: JSON.stringify({ text: combinedText }),
                }
              : {}),
            mentions: mergedMentions ?? dispatchEntry.message.mentions,
          },
        },
        dispatchDedupeKey,
      );
    },
    onError: (err, entries) => {
      for (const entry of entries) {
        releaseFeishuMessageProcessing(resolveFeishuMessageDedupeKey(entry), accountId);
      }
      error(`feishu[${accountId}]: inbound debounce flush failed: ${String(err)}`);
    },
  });

  return (data) => {
    const event = parseFeishuMessageEventPayload(data);
    if (!event) {
      error(`feishu[${accountId}]: ignoring malformed message event payload`);
      return Promise.resolve();
    }
    const messageId = event.message?.message_id?.trim();
    const botOpenId = getBotOpenId(accountId)?.trim();
    const senderOpenId = event.sender.sender_id.open_id?.trim();
    if (botOpenId && senderOpenId === botOpenId) {
      // Feishu bot receive events identify their sender by open_id. Drop this
      // account's bot before it can consume a claim or debounce slot.
      log(`feishu[${accountId}]: dropping self-authored message ${messageId ?? "unknown"}`);
      return Promise.resolve();
    }
    const messageDedupeKey = resolveFeishuMessageDedupeKey(event);
    const processingClaimKey = resolveFeishuProcessingClaimKey({ event, messageDedupeKey });
    if (!tryBeginFeishuMessageProcessing(processingClaimKey, accountId)) {
      log(`feishu[${accountId}]: dropping duplicate event for message ${messageId}`);
      return Promise.resolve();
    }
    log(
      `feishu[${accountId}]: queued receive event message=${messageId ?? "unknown"} ` +
        `chat_type=${event.message.chat_type} ` +
        `thread=${event.message.thread_id?.trim() || "none"} ` +
        `root=${event.message.root_id?.trim() || "none"}`,
    );
    const processMessage = async () => {
      await inboundDebouncer.enqueue(event);
    };
    if (fireAndForget) {
      setImmediate(() => {
        void processMessage().catch((err: unknown) => {
          releaseFeishuMessageProcessing(processingClaimKey, accountId);
          error(`feishu[${accountId}]: error handling message: ${String(err)}`);
        });
      });
      return Promise.resolve();
    }
    return processMessage().catch((err: unknown) => {
      releaseFeishuMessageProcessing(processingClaimKey, accountId);
      error(`feishu[${accountId}]: error handling message: ${String(err)}`);
    });
  };
}
