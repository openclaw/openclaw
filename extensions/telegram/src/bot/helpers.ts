import type { Chat, Message } from "grammy/types";
import { firstDefined } from "openclaw/plugin-sdk/allow-from";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import type {
  OpenClawConfig,
  DmPolicy,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import {
  asDateTimestampMs,
  parseStrictPositiveInteger,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { expandTelegramAllowFromWithAccessGroups } from "../access-groups.js";
import {
  isSenderAllowed,
  normalizeAllowFrom,
  resolveTelegramEffectiveDmPolicy,
  type NormalizedAllowFrom,
} from "../bot-access.js";
import { normalizeTelegramReplyToMessageId } from "../outbound-params.js";
import type { TelegramThreadSpec } from "../thread-spec.js";
import { buildTelegramConversationId } from "../topic-conversation.js";
import {
  buildSenderLabel,
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  hasBotMention,
  isBinaryContent,
  joinTelegramTextParts,
  normalizeForwardedContext,
  resolveTelegramPrimaryMedia,
  resolveTelegramRichMessageBody,
  resolveTelegramTextContent,
  type TelegramForwardedContext,
  type TelegramMediaKind,
  type TelegramTextEntity,
} from "./body-helpers.js";
import type { TelegramGetChat } from "./types.js";

export { resolveTelegramPreviewStreamMode as resolveTelegramStreamMode } from "../preview-streaming.js";

export type {
  TelegramForwardedContext,
  TelegramMediaKind,
  TelegramTextEntity,
} from "./body-helpers.js";
export type { TelegramThreadSpec } from "../thread-spec.js";
export {
  buildSenderLabel,
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  hasBotMention,
  isBinaryContent,
  joinTelegramTextParts,
  normalizeForwardedContext,
  resolveTelegramPrimaryMedia,
};

export const TELEGRAM_GENERAL_TOPIC_ID = 1;
const TELEGRAM_FORUM_FLAG_CACHE_MAX_CHATS = 1024;
const TELEGRAM_FORUM_FLAG_CACHE_TTL_MS = 10 * 60_000;
const telegramForumFlagByChatId = new Map<string, { expiresAtMs: number; isForum: boolean }>();

function cacheTelegramForumFlag(chatId: string | number, isForum: boolean, nowMs = Date.now()) {
  const cacheKey = String(chatId);
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(TELEGRAM_FORUM_FLAG_CACHE_TTL_MS, {
    nowMs,
  });
  if (expiresAtMs === undefined) {
    telegramForumFlagByChatId.delete(cacheKey);
    return;
  }
  if (
    !telegramForumFlagByChatId.has(cacheKey) &&
    telegramForumFlagByChatId.size >= TELEGRAM_FORUM_FLAG_CACHE_MAX_CHATS
  ) {
    const oldestKey = telegramForumFlagByChatId.keys().next().value;
    if (oldestKey !== undefined) {
      telegramForumFlagByChatId.delete(oldestKey);
    }
  }
  telegramForumFlagByChatId.set(cacheKey, {
    expiresAtMs,
    isForum,
  });
}

export function getCachedTelegramForumFlag(
  chatId: string | number,
  nowMs?: number,
): boolean | undefined {
  const cacheKey = String(chatId);
  const cached = telegramForumFlagByChatId.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  const effectiveNow = nowMs ?? Date.now();
  if (cached.expiresAtMs <= effectiveNow) {
    return undefined;
  }
  return cached.isForum;
}

function hadUnsafeTelegramText(raw: unknown, sanitized: string): boolean {
  return typeof raw === "string" && raw.trim().length > 0 && sanitized.trim().length === 0;
}

type TelegramThreadParams = {
  direct_messages_topic_id?: number;
  message_thread_id?: number;
};

export function shouldUseTelegramDmThreadSession(params: {
  dmThreadId?: number;
  botHasTopicsEnabled?: boolean;
}): boolean {
  return params.dmThreadId != null && params.botHasTopicsEnabled === true;
}

export function resolveTelegramBotHasTopicsEnabled(me: unknown): boolean {
  return (
    me !== null &&
    typeof me === "object" &&
    "has_topics_enabled" in me &&
    me.has_topics_enabled === true
  );
}

export function extractTelegramForumFlag(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object" || !("is_forum" in value)) {
    return undefined;
  }
  const forum = value.is_forum;
  return typeof forum === "boolean" ? forum : undefined;
}

export function resolveTelegramMessageForumFlagHint(params: {
  chatType?: Chat["type"];
  isForum?: boolean;
  isTopicMessage?: boolean;
}): boolean | undefined {
  if (params.chatType === "supergroup" && params.isTopicMessage === true) {
    return true;
  }
  return typeof params.isForum === "boolean" ? params.isForum : undefined;
}

export async function resolveTelegramForumFlag(params: {
  chatId: string | number;
  chatType?: Chat["type"];
  isGroup: boolean;
  isForum?: boolean;
  isTopicMessage?: boolean;
  getChat?: TelegramGetChat;
}): Promise<boolean> {
  const forumHint = resolveTelegramMessageForumFlagHint({
    chatType: params.chatType,
    isForum: params.isForum,
    isTopicMessage: params.isTopicMessage,
  });
  if (typeof forumHint === "boolean") {
    if (params.isGroup && params.chatType === "supergroup") {
      cacheTelegramForumFlag(params.chatId, forumHint);
    }
    return forumHint;
  }
  if (!params.isGroup || params.chatType !== "supergroup" || !params.getChat) {
    return false;
  }
  const cacheKey = String(params.chatId);
  const rawNowMs = Date.now();
  const nowMs = asDateTimestampMs(rawNowMs);
  const cached = telegramForumFlagByChatId.get(cacheKey);
  if (cached) {
    if (
      nowMs !== undefined &&
      asDateTimestampMs(cached.expiresAtMs) !== undefined &&
      cached.expiresAtMs > nowMs
    ) {
      return cached.isForum;
    }
    telegramForumFlagByChatId.delete(cacheKey);
  }
  try {
    const resolved = extractTelegramForumFlag(await params.getChat(params.chatId)) === true;
    cacheTelegramForumFlag(params.chatId, resolved, rawNowMs);
    return resolved;
  } catch {
    return false;
  }
}

// Preserve recovered forum metadata so downstream handlers do not need to re-query getChat.
export function withResolvedTelegramForumFlag<T extends { chat: object }>(
  message: T,
  isForum: boolean,
): T {
  const current = extractTelegramForumFlag(message.chat);
  if (current === isForum) {
    return message;
  }
  return {
    ...message,
    chat: {
      ...message.chat,
      is_forum: isForum,
    },
  };
}

export async function resolveTelegramGroupAllowFromContext(params: {
  cfg: OpenClawConfig;
  chatId: string | number;
  accountId?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  senderId?: string;
  isGroup?: boolean;
  isForum?: boolean;
  messageThreadId?: number | null;
  threadSpec?: TelegramThreadSpec;
  groupAllowFrom?: Array<string | number>;
  // Set when the caller has already authorized the sender by some other config
  // path (e.g. commands.allowFrom) and the pairing-store outcome cannot change
  // the decision. Lets command auth survive transient store I/O failures.
  skipPairingStoreRead?: boolean;
  readChannelAllowFromStore?: typeof readChannelAllowFromStore;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId: number | undefined,
    cfg: OpenClawConfig,
  ) => {
    groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
    topicConfig?: TelegramTopicConfig;
  };
}): Promise<{
  threadSpec: TelegramThreadSpec;
  resolvedThreadId?: number;
  dmThreadId?: number;
  storeAllowFrom: string[];
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  groupAllowOverride?: Array<string | number>;
  effectiveGroupAllow: NormalizedAllowFrom;
  hasGroupAllowOverride: boolean;
}> {
  const accountId = normalizeAccountId(params.accountId);
  const threadSpec =
    params.threadSpec ??
    resolveTelegramThreadSpec({
      isGroup: params.isGroup ?? false,
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
    });
  const resolvedThreadId =
    threadSpec.scope === "forum" || threadSpec.scope === "direct-messages"
      ? threadSpec.id
      : undefined;
  const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
  const threadIdForConfig = resolvedThreadId ?? dmThreadId;
  const { groupConfig, topicConfig } = params.resolveTelegramGroupConfig(
    params.chatId,
    threadIdForConfig,
    params.cfg,
  );
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
    isGroup: params.isGroup ?? false,
    groupConfig,
    dmPolicy: params.dmPolicy,
  });
  const storeAllowFrom = await loadTelegramPairingStoreIfNeeded({
    cfg: params.cfg,
    allowFrom: params.allowFrom,
    groupAllowOverride,
    accountId,
    senderId: params.senderId,
    isGroup: params.isGroup ?? false,
    effectiveDmPolicy,
    skipPairingStoreRead: params.skipPairingStoreRead,
    readChannelAllowFromStore: params.readChannelAllowFromStore,
  });
  const expandedGroupAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom: groupAllowOverride ?? params.groupAllowFrom,
    accountId,
    senderId: params.senderId,
  });
  // Group sender access must remain explicit (groupAllowFrom/per-group allowFrom only).
  // DM pairing store entries are not a group authorization source.
  const effectiveGroupAllow = normalizeAllowFrom(expandedGroupAllowFrom);
  const hasGroupAllowOverride = groupAllowOverride !== undefined;
  return {
    threadSpec,
    resolvedThreadId,
    dmThreadId,
    storeAllowFrom,
    groupConfig,
    topicConfig,
    groupAllowOverride,
    effectiveGroupAllow,
    hasGroupAllowOverride,
  };
}

async function isTelegramDmAllowedByConfiguredAllowFrom(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  groupAllowOverride?: Array<string | number>;
  accountId: string;
  senderId?: string;
}): Promise<boolean> {
  const configuredAllowFrom = params.groupAllowOverride ?? params.allowFrom;
  if (!configuredAllowFrom || configuredAllowFrom.length === 0) {
    return false;
  }
  const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom: configuredAllowFrom,
    accountId: params.accountId,
    senderId: params.senderId,
  });
  const normalizedAllowFrom = normalizeAllowFrom(expandedAllowFrom);
  return (
    normalizedAllowFrom.hasEntries &&
    isSenderAllowed({
      allow: normalizedAllowFrom,
      senderId: params.senderId,
    })
  );
}

export class TelegramPairingStoreReadError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(`Telegram pairing store read failed: ${String(cause)}`);
    this.name = "TelegramPairingStoreReadError";
    this.cause = cause;
  }
}

async function loadTelegramPairingStoreIfNeeded(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  groupAllowOverride?: Array<string | number>;
  accountId: string;
  senderId?: string;
  isGroup: boolean;
  effectiveDmPolicy: DmPolicy;
  skipPairingStoreRead?: boolean;
  readChannelAllowFromStore?: typeof readChannelAllowFromStore;
}): Promise<string[]> {
  if (params.skipPairingStoreRead || params.isGroup || params.effectiveDmPolicy !== "pairing") {
    return [];
  }
  const configuredDmAllowed = await isTelegramDmAllowedByConfiguredAllowFrom({
    cfg: params.cfg,
    allowFrom: params.allowFrom,
    groupAllowOverride: params.groupAllowOverride,
    accountId: params.accountId,
    senderId: params.senderId,
  });
  if (configuredDmAllowed) {
    return [];
  }
  try {
    return await (params.readChannelAllowFromStore ?? readChannelAllowFromStore)(
      "telegram",
      process.env,
      params.accountId,
    );
  } catch (cause) {
    throw new TelegramPairingStoreReadError(cause);
  }
}

// Reply threads in non-forum groups must not create separate sessions.
export function resolveTelegramForumThreadId(params: {
  isForum?: boolean;
  messageThreadId?: number | null;
}) {
  return params.isForum ? (params.messageThreadId ?? TELEGRAM_GENERAL_TOPIC_ID) : undefined;
}

export function resolveTelegramThreadSpec(params: {
  isGroup: boolean;
  isForum?: boolean;
  messageThreadId?: number | null;
}): TelegramThreadSpec {
  if (params.isGroup) {
    const id = resolveTelegramForumThreadId({
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
    });
    return id === undefined ? { scope: "none" } : { id, scope: "forum" };
  }
  if (params.messageThreadId == null) {
    return { scope: "dm" };
  }
  return {
    id: params.messageThreadId,
    scope: "dm",
  };
}

export function resolveTelegramMessageThreadSpec(
  message: Message,
  isForum?: boolean,
): TelegramThreadSpec {
  if (message.chat.is_direct_messages === true) {
    const id = parseStrictPositiveInteger(message.direct_messages_topic?.topic_id);
    return id === undefined ? { scope: "none" } : { id, scope: "direct-messages" };
  }
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  return resolveTelegramThreadSpec({
    isGroup,
    isForum:
      isForum ??
      resolveTelegramMessageForumFlagHint({
        chatType: message.chat.type,
        isForum: message.chat.is_forum,
        isTopicMessage: message.is_topic_message,
      }),
    messageThreadId: message.message_thread_id,
  });
}

export function buildTelegramThreadParams(
  thread?: TelegramThreadSpec | null,
): TelegramThreadParams | undefined {
  if (thread?.id == null) {
    return undefined;
  }
  const normalized = Math.trunc(thread.id);

  if (!Number.isFinite(normalized)) {
    return undefined;
  }

  if (thread.scope === "dm") {
    return normalized > 0 ? { message_thread_id: normalized } : undefined;
  }

  if (thread.scope === "direct-messages") {
    return normalized > 0 ? { direct_messages_topic_id: normalized } : undefined;
  }

  if (thread.scope === "none") {
    return undefined;
  }

  // Telegram rejects message_thread_id=1 for General forum topic
  if (normalized === TELEGRAM_GENERAL_TOPIC_ID) {
    return undefined;
  }

  return { message_thread_id: normalized };
}

// Generic reply plumbing may omit threadId, so keep sendable topic IDs in-band.
export function buildTelegramRoutingTarget(
  chatId: number | string,
  thread?: TelegramThreadSpec | null,
): string {
  const base = `telegram:${chatId}`;
  const threadParams = buildTelegramThreadParams(thread);
  if (threadParams?.direct_messages_topic_id != null) {
    return `${base}:direct-topic:${threadParams.direct_messages_topic_id}`;
  }
  return threadParams?.message_thread_id != null
    ? `${base}:topic:${threadParams.message_thread_id}`
    : base;
}

// Bot-private thread IDs remain metadata-only for queued follow-up routing.
export function buildTelegramInboundOriginTarget(
  chatId: number | string,
  thread?: TelegramThreadSpec | null,
): string {
  if (thread?.scope !== "forum" && thread?.scope !== "direct-messages") {
    return `telegram:${chatId}`;
  }
  return buildTelegramRoutingTarget(chatId, thread);
}

// Unlike sends, typing in General topic needs message_thread_id=1 to appear.
export function buildTypingThreadParams(messageThreadId?: number) {
  if (messageThreadId == null) {
    return undefined;
  }
  return { message_thread_id: Math.trunc(messageThreadId) };
}

export function buildTelegramGroupPeerId(
  chatId: number | string,
  thread?: number | TelegramThreadSpec,
) {
  const threadSpec = typeof thread === "number" ? { id: thread, scope: "forum" as const } : thread;
  return buildTelegramConversationId({ chatId, thread: threadSpec ?? { scope: "none" } });
}

export function buildTelegramGroupFrom(
  chatId: number | string,
  thread?: number | TelegramThreadSpec,
) {
  return `telegram:group:${buildTelegramGroupPeerId(chatId, thread)}`;
}

export function isTelegramCommandsAllowFromConfigured(cfg: OpenClawConfig): boolean {
  const commandsAllowFrom = cfg.commands?.allowFrom;
  return (
    commandsAllowFrom != null &&
    typeof commandsAllowFrom === "object" &&
    (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]))
  );
}

// Topic routes inherit bindings from the base group when no exact topic binding matches.
export function buildTelegramParentPeer(params: {
  isGroup: boolean;
  resolvedThreadId?: number;
  chatId: number | string;
}): { kind: "group"; id: string } | undefined {
  if (!params.isGroup || params.resolvedThreadId == null) {
    return undefined;
  }
  return { kind: "group", id: String(params.chatId) };
}

export function buildGroupLabel(msg: Message, chatId: number | string, messageThreadId?: number) {
  const title = msg.chat?.title;
  const topicSuffix = messageThreadId != null ? ` topic:${messageThreadId}` : "";
  if (title) {
    return `${title} id:${chatId}${topicSuffix}`;
  }
  return `group:${chatId}${topicSuffix}`;
}

export function resolveTelegramReplyId(raw?: string): number | undefined {
  return normalizeTelegramReplyToMessageId(raw);
}

export type TelegramReplyTarget = {
  id?: string;
  sender: string;
  senderId?: string;
  senderUsername?: string;
  body?: string;
  mediaType?: TelegramMediaKind;
  kind: "reply" | "quote";
  source: "reply_to_message" | "external_reply";
  quoteText?: string;
  quotePosition?: number;
  quoteEntities?: TelegramTextEntity[];
  /** Forward context if the reply target was itself a forwarded message (issue #9619). */
  forwardedFrom?: TelegramForwardedContext;
  quoteSourceText?: string;
  quoteSourceEntities?: TelegramTextEntity[];
};

export function describeReplyTarget(msg: Message): TelegramReplyTarget | null {
  const reply = msg.reply_to_message;
  const externalReply = (msg as Message & { external_reply?: Message }).external_reply;
  const quote =
    msg.quote ?? (externalReply as (Message & { quote?: Message["quote"] }) | undefined)?.quote;
  const rawQuoteText = quote?.text;
  const quoteText = resolveTelegramTextContent(rawQuoteText);
  let body = quoteText.trim();
  const kind: TelegramReplyTarget["kind"] = body ? "quote" : "reply";
  const filteredQuoteText = hadUnsafeTelegramText(rawQuoteText, quoteText);

  const replyLike = reply ?? externalReply;
  const externalOrigin = reply ? undefined : msg.external_reply?.origin;
  const senderMessage =
    replyLike && externalOrigin?.type === "user"
      ? { ...replyLike, from: externalOrigin.sender_user }
      : replyLike;
  const replyMedia = resolveTelegramPrimaryMedia(replyLike);
  const rawReplyText =
    replyLike && typeof replyLike.text === "string"
      ? replyLike.text
      : replyLike && typeof replyLike.caption === "string"
        ? replyLike.caption
        : undefined;
  const replyTextParts = replyLike ? getTelegramTextParts(replyLike) : undefined;
  const safeReplyText = replyTextParts?.text ?? "";
  let filteredReplyText = false;
  if (!body && replyLike) {
    const replyBody = safeReplyText.trim() || resolveTelegramRichMessageBody(replyLike) || "";
    filteredReplyText = hadUnsafeTelegramText(rawReplyText, replyBody);
    body = replyBody;
    if (!body) {
      const locationData = extractTelegramLocation(replyLike);
      if (locationData) {
        body = formatLocationText(locationData);
      }
    }
  }
  if (!body && !replyLike) {
    return null;
  }
  if (!body && !replyMedia && !filteredQuoteText && !filteredReplyText) {
    return null;
  }
  const sender = senderMessage ? buildSenderName(senderMessage) : undefined;
  const senderLabel = sender ?? "unknown sender";
  const source = reply ? "reply_to_message" : "external_reply";
  const quotePosition =
    kind === "quote" && typeof quote?.position === "number" && Number.isFinite(quote.position)
      ? Math.trunc(quote.position)
      : undefined;
  const quoteEntities =
    kind === "quote" && Array.isArray(quote?.entities) ? quote.entities : undefined;

  const forwardedFrom = replyLike ? (normalizeForwardedContext(replyLike) ?? undefined) : undefined;

  return {
    id: replyLike?.message_id ? String(replyLike.message_id) : undefined,
    sender: senderLabel,
    senderId: senderMessage?.from?.id != null ? String(senderMessage.from.id) : undefined,
    senderUsername: senderMessage?.from?.username ?? undefined,
    body: body || undefined,
    mediaType: replyMedia?.kind,
    kind,
    source,
    quoteText: kind === "quote" ? quoteText : undefined,
    quotePosition,
    quoteEntities,
    forwardedFrom,
    quoteSourceText: replyTextParts?.text || undefined,
    quoteSourceEntities: replyTextParts?.entities,
  };
}
