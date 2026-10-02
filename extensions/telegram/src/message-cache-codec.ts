import type { Message } from "grammy/types";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveTelegramPrimaryMedia,
  resolveTelegramRichMessageBody,
  type TelegramMediaKind,
} from "./bot/body-helpers.js";
import {
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  normalizeForwardedContext,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import {
  isTelegramMessageCacheSourceMessage,
  parseTelegramResolvedMedia,
  type PersistedTelegramMessageCacheValue,
  type TelegramResolvedMedia,
  TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
  type TelegramMessageThreadBinding,
} from "./message-cache-persistence.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";
import {
  parseTelegramPromptContextProjection,
  type TelegramPromptContextProjectionMarker,
} from "./prompt-context-projection.js";

export type TelegramReplyChainEntry = NonNullable<MsgContext["ReplyChain"]>[number] & {
  mediaKind?: TelegramMediaKind;
};

export type TelegramCachedMessageNode = Omit<TelegramReplyChainEntry, "messageId"> & {
  messageId: string;
  resolvedMedia?: TelegramResolvedMedia;
  sourceMessage: Message;
  promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
  threadBinding?: TelegramMessageThreadBinding;
  historyEligible?: true;
};

type MessageWithPromptContextTimestamp = Message & {
  openclaw_prompt_context_timestamp_ms?: unknown;
};

export type TelegramMessageObservationMode = "authoritative" | "partial";

type TelegramCachedMessageObservation = {
  node: TelegramCachedMessageNode;
  mode: TelegramMessageObservationMode;
};

export function retainedMessageId(messageId: string): string | undefined {
  const id = parseStrictPositiveInteger(messageId);
  return id !== undefined && id <= 9_999_999_999 ? String(id).padStart(10, "0") : undefined;
}

export function isGroupMessage(msg: Message): boolean {
  return msg.chat?.type === "group" || msg.chat?.type === "supergroup";
}

export function resolveReplyMessage(msg: Message) {
  if (msg.reply_to_message) {
    return msg.reply_to_message;
  }
  const externalReply = msg.external_reply;
  return externalReply?.chat && externalReply.chat.id === msg.chat?.id ? externalReply : undefined;
}

export function isTelegramMessageFromCurrentBot(msg: Message, botUserId?: number): boolean {
  const currentBotUserId = parseStrictPositiveInteger(botUserId);
  if (currentBotUserId === undefined) {
    return msg.from?.is_bot === true;
  }
  return msg.from?.id === currentBotUserId || msg.sender_business_bot?.id === currentBotUserId;
}

function resolveMessageBody(msg: Message, preserveWhitespace: boolean): string | undefined {
  const text = getTelegramTextParts(msg).text;
  if (text.trim()) {
    return preserveWhitespace ? text : text.trim();
  }
  const location = extractTelegramLocation(msg);
  if (location) {
    return formatLocationText(location);
  }
  return resolveTelegramRichMessageBody(msg);
}

function resolveMessageTimestamp(msg: MessageWithPromptContextTimestamp): number | undefined {
  const promptContextTimestamp = msg.openclaw_prompt_context_timestamp_ms;
  return typeof promptContextTimestamp === "number" && Number.isFinite(promptContextTimestamp)
    ? promptContextTimestamp
    : msg.date
      ? msg.date * 1000
      : undefined;
}

export function normalizeMessageNode(
  msg: Message,
  params: {
    threadId?: number;
    promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
    resolvedMedia?: TelegramResolvedMedia;
    threadBinding?: TelegramMessageThreadBinding;
    historyEligible?: boolean;
  },
): TelegramCachedMessageNode {
  const media = resolveTelegramPrimaryMedia(msg);
  const fileId = media?.fileRef.file_id;
  const forwardedFrom = normalizeForwardedContext(msg);
  const replyMessage = resolveReplyMessage(msg);
  const body = resolveMessageBody(msg, params.promptContextProjectionMarker !== undefined);
  const threadBinding = normalizeTelegramMessageThreadBinding(params.threadBinding);
  const threadId =
    threadBinding?.threadSpec.scope === "none"
      ? undefined
      : parseTelegramMessageThreadId(threadBinding?.threadSpec.id ?? params.threadId);
  const timestamp = resolveMessageTimestamp(msg);
  return {
    sourceMessage: msg,
    messageId: String(msg.message_id),
    sender: buildSenderName(msg) ?? "unknown sender",
    ...(msg.from?.id != null ? { senderId: String(msg.from.id) } : {}),
    ...(msg.from?.username ? { senderUsername: msg.from.username } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(body ? { body } : {}),
    ...(media ? { mediaType: media.kind } : {}),
    ...(fileId ? { mediaRef: `telegram:file/${fileId}` } : {}),
    ...(replyMessage?.message_id != null ? { replyToId: String(replyMessage.message_id) } : {}),
    ...(forwardedFrom?.from ? { forwardedFrom: forwardedFrom.from } : {}),
    ...(forwardedFrom?.fromId ? { forwardedFromId: forwardedFrom.fromId } : {}),
    ...(forwardedFrom?.fromUsername ? { forwardedFromUsername: forwardedFrom.fromUsername } : {}),
    ...(forwardedFrom?.date ? { forwardedDate: forwardedFrom.date * 1000 } : {}),
    ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
    ...(params.promptContextProjectionMarker
      ? { promptContextProjectionMarker: params.promptContextProjectionMarker }
      : {}),
    ...(params.resolvedMedia ? { resolvedMedia: params.resolvedMedia } : {}),
    ...(threadBinding ? { threadBinding } : {}),
    ...(params.historyEligible === true ? { historyEligible: true } : {}),
  };
}

function normalizeTelegramMessageThreadBinding(
  value: unknown,
): TelegramMessageThreadBinding | undefined {
  if (!isRecord(value) || value.kind !== "provider-observed-v1") {
    return undefined;
  }
  const threadSpec = value.threadSpec;
  if (!isRecord(threadSpec)) {
    return undefined;
  }
  if (threadSpec.scope === "none" && threadSpec.id === undefined) {
    return { kind: "provider-observed-v1", threadSpec: { scope: "none" } };
  }
  const id = parseTelegramMessageThreadId(threadSpec.id);
  if (
    id === undefined ||
    (threadSpec.scope !== "direct-messages" &&
      threadSpec.scope !== "dm" &&
      threadSpec.scope !== "forum")
  ) {
    return undefined;
  }
  return { kind: "provider-observed-v1", threadSpec: { scope: threadSpec.scope, id } };
}

export function createTelegramMessageThreadBinding(
  threadSpec: TelegramThreadSpec | undefined,
): TelegramMessageThreadBinding | undefined {
  return normalizeTelegramMessageThreadBinding({ kind: "provider-observed-v1", threadSpec });
}

export function hasProviderObservedTelegramThreadBinding(
  node: TelegramCachedMessageNode | null | undefined,
  threadId: unknown,
): boolean {
  const normalizedThreadId = parseTelegramMessageThreadId(threadId);
  return (
    normalizedThreadId !== undefined &&
    resolveProviderObservedTelegramThreadSpec(node)?.id === normalizedThreadId
  );
}

export function resolveProviderObservedTelegramThreadSpec(
  node: TelegramCachedMessageNode | null | undefined,
): Exclude<TelegramMessageThreadBinding["threadSpec"], { scope: "none" }> | undefined {
  const threadSpec = normalizeTelegramMessageThreadBinding(node?.threadBinding)?.threadSpec;
  return threadSpec?.scope === "none" ? undefined : threadSpec;
}

export function normalizeMessageNodes(
  msg: Message,
  params: Parameters<typeof normalizeMessageNode>[1],
): TelegramCachedMessageObservation[] {
  const observations: TelegramCachedMessageObservation[] = [];
  const visited = new Set<string>();
  const visit = (
    message: Message,
    options: Parameters<typeof normalizeMessageNode>[1],
    mode: TelegramMessageObservationMode,
  ) => {
    const embeddedThreadId = parseTelegramMessageThreadId(message.message_thread_id);
    const inheritedThread = parseTelegramMessageThreadId(options.threadId);
    const observedBinding = normalizeTelegramMessageThreadBinding(options.threadBinding);
    const threadId =
      mode === "authoritative"
        ? observedBinding?.threadSpec.scope === "none"
          ? undefined
          : (observedBinding?.threadSpec.id ?? inheritedThread ?? embeddedThreadId)
        : (embeddedThreadId ?? inheritedThread);
    const node = normalizeMessageNode(message, {
      ...options,
      threadId,
      threadBinding: observedBinding?.threadSpec.id === threadId ? observedBinding : undefined,
    });
    if (visited.has(node.messageId)) {
      return;
    }
    visited.add(node.messageId);
    const replyMessage = message.reply_to_message;
    if (replyMessage?.message_id != null) {
      visit(
        replyMessage,
        {
          threadId:
            node.threadBinding?.threadSpec.scope === "none"
              ? undefined
              : (parseTelegramMessageThreadId(node.threadId) ?? options.threadId),
          threadBinding: node.threadBinding,
        },
        "partial",
      );
    }
    observations.push({ node, mode });
  };
  visit(msg, params, "authoritative");
  return observations;
}

export function parsePersistedCacheValue(key: string, value: unknown) {
  if (
    !isRecord(value) ||
    (value.version !== undefined && value.version !== TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION)
  ) {
    return [];
  }
  const separatorIndex = key.lastIndexOf(":");
  if (separatorIndex === -1 || !isTelegramMessageCacheSourceMessage(value.sourceMessage)) {
    return [];
  }
  const threadId = parseTelegramMessageThreadId(value.threadId);
  const botUserId = parseStrictPositiveInteger(value.botUserId);
  const promptContextProjectionMarker =
    value.version === TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION &&
    isTelegramMessageFromCurrentBot(value.sourceMessage, botUserId)
      ? parseTelegramPromptContextProjection(value.promptContextProjection)
      : undefined;
  const threadBinding =
    value.version === TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION
      ? normalizeTelegramMessageThreadBinding(value.threadBinding)
      : undefined;
  const resolvedMedia = parseTelegramResolvedMedia(value.resolvedMedia);
  return normalizeMessageNodes(value.sourceMessage, {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
    ...(threadBinding ? { threadBinding } : {}),
    ...(resolvedMedia ? { resolvedMedia } : {}),
    ...(value.version === TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION && value.historyEligible === true
      ? { historyEligible: true }
      : {}),
  }).map(({ node, mode }) => ({
    key: `${key.slice(0, separatorIndex + 1)}${node.messageId}`,
    node,
    mode,
  }));
}

function mergeTelegramSourceMessage<T extends Message>(existing: T, incoming: Message): T {
  const existingReply = existing.reply_to_message;
  const incomingReply = incoming.reply_to_message;
  if (!incomingReply || (existingReply && existingReply.message_id !== incomingReply.message_id)) {
    return existing;
  }
  const reply = existingReply
    ? mergeTelegramSourceMessage(existingReply, incomingReply)
    : incomingReply;
  return reply === existingReply ? existing : { ...existing, reply_to_message: reply };
}

export function mergeCachedMessageNode(
  existing: TelegramCachedMessageNode,
  incoming: TelegramCachedMessageNode,
  mode: TelegramMessageObservationMode,
): TelegramCachedMessageNode {
  const preferExisting =
    mode === "partial" ||
    (existing.sourceMessage.edit_date !== undefined &&
      existing.sourceMessage.edit_date >
        (incoming.sourceMessage.edit_date ?? incoming.sourceMessage.date));
  const mergedSourceMessage = preferExisting
    ? mergeTelegramSourceMessage(existing.sourceMessage, incoming.sourceMessage)
    : mergeTelegramSourceMessage(incoming.sourceMessage, existing.sourceMessage);
  const syntheticOutboundFrom =
    existing.senderId === "0" && incoming.sourceMessage.sender_chat
      ? existing.sourceMessage.from
      : undefined;
  // sender_chat pairs with a fake `from`; preserve our outbound-only id=0 sentinel.
  const sourceMessage = syntheticOutboundFrom
    ? { ...mergedSourceMessage, from: syntheticOutboundFrom }
    : mergedSourceMessage;
  const preferred = preferExisting ? existing : incoming;
  const other = preferExisting ? incoming : existing;
  const promptContextProjectionMarker =
    preferred.promptContextProjectionMarker ?? other.promptContextProjectionMarker;
  const threadBinding =
    normalizeTelegramMessageThreadBinding(preferred.threadBinding) ??
    normalizeTelegramMessageThreadBinding(other.threadBinding);
  const threadId =
    threadBinding?.threadSpec.scope === "none"
      ? undefined
      : parseTelegramMessageThreadId(
          threadBinding?.threadSpec.id ?? preferred.threadId ?? other.threadId,
        );
  const primaryMediaId = resolveTelegramPrimaryMedia(sourceMessage)?.fileRef.file_unique_id;
  const resolvedMedia =
    preferred.resolvedMedia?.fileUniqueId === primaryMediaId
      ? preferred.resolvedMedia
      : other.resolvedMedia?.fileUniqueId === primaryMediaId
        ? other.resolvedMedia
        : undefined;
  return normalizeMessageNode(sourceMessage, {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
    ...(threadBinding ? { threadBinding } : {}),
    ...(resolvedMedia ? { resolvedMedia } : {}),
    ...(existing.historyEligible || incoming.historyEligible ? { historyEligible: true } : {}),
  });
}

export function persistedCacheNode(
  node: TelegramCachedMessageNode,
  botUserId?: number,
): PersistedTelegramMessageCacheValue {
  const marker = node.promptContextProjectionMarker;
  const promptContextProjection =
    marker?.kind === "valid"
      ? marker.projection
      : marker
        ? { transcriptMessageId: marker.transcriptMessageId }
        : undefined;
  return {
    version: TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
    sourceMessage: node.sourceMessage,
    ...(botUserId !== undefined ? { botUserId } : {}),
    ...(promptContextProjection ? { promptContextProjection } : {}),
    ...(node.resolvedMedia ? { resolvedMedia: node.resolvedMedia } : {}),
    ...(node.threadBinding ? { threadBinding: node.threadBinding } : {}),
    ...(node.threadId ? { threadId: node.threadId } : {}),
    ...(node.historyEligible ? { historyEligible: true } : {}),
  };
}

export function parseRetainedCacheNode(
  key: string,
  value: unknown,
): TelegramCachedMessageNode | null {
  const node = parsePersistedCacheValue(key, value).at(-1)?.node;
  if (!node || !isGroupMessage(node.sourceMessage)) {
    return null;
  }
  const id = retainedMessageId(node.messageId);
  return id && key.endsWith(`:${node.sourceMessage.chat.id}:${id}`) ? node : null;
}

export function compareCachedMessageNodes(
  left: TelegramCachedMessageNode,
  right: TelegramCachedMessageNode,
) {
  const leftId = parseStrictPositiveInteger(left.messageId);
  const rightId = parseStrictPositiveInteger(right.messageId);
  if (leftId !== undefined && rightId !== undefined) {
    return leftId - rightId;
  }
  return (left.messageId ?? "").localeCompare(right.messageId ?? "");
}
