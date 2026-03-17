import { toLocationContext } from "openclaw/plugin-sdk/channel-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { normalizeCommandBody } from "openclaw/plugin-sdk/reply-runtime";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/reply-runtime";
import {
  buildPendingHistoryContextFromMap,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { normalizeAllowFrom } from "./bot-access.js";
import type {
  TelegramMediaRef,
  TelegramMessageContextOptions,
} from "./bot-message-context.types.js";
import {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  describeReplyTarget,
  normalizeForwardedContext,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramGroupPromptSettings } from "./group-config-helpers.js";

export async function buildTelegramInboundContextPayload(params: {
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  replyMedia: TelegramMediaRef[];
  isGroup: boolean;
  isForum: boolean;
  chatId: number | string;
  senderId: string;
  senderUsername: string;
  resolvedThreadId?: number;
  dmThreadId?: number;
  threadSpec: TelegramThreadSpec;
  route: ResolvedAgentRoute;
  rawBody: string;
  bodyText: string;
  historyKey?: string;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  stickerCacheHit: boolean;
  effectiveWasMentioned: boolean;
  commandAuthorized: boolean;
  locationData?: import("openclaw/plugin-sdk/channel-runtime").NormalizedLocation;
  options?: TelegramMessageContextOptions;
  dmAllowFrom?: Array<string | number>;
}): Promise<{
  ctxPayload: ReturnType<typeof finalizeInboundContext>;
  skillFilter: string[] | undefined;
}> {
  const {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    replyMedia,
    isGroup,
    isForum,
    chatId,
    senderId,
    senderUsername,
    resolvedThreadId,
    dmThreadId,
    threadSpec,
    route,
    rawBody,
    bodyText,
    historyKey,
    historyLimit,
    groupHistories,
    groupConfig,
    topicConfig,
    stickerCacheHit,
    effectiveWasMentioned,
    commandAuthorized,
    locationData,
    options,
    dmAllowFrom,
  } = params;
  const replyTarget = describeReplyTarget(msg);
  const forwardOrigin = normalizeForwardedContext(msg);
  const replyForwardAnnotation = replyTarget?.forwardedFrom
    ? `[Forwarded from ${replyTarget.forwardedFrom.from}${
        replyTarget.forwardedFrom.date
          ? ` at ${new Date(replyTarget.forwardedFrom.date * 1000).toISOString()}`
          : ""
      }]\n`
    : "";
  const replySuffix = replyTarget
    ? replyTarget.kind === "quote"
      ? `\n\n[Quoting ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n${replyForwardAnnotation}"${replyTarget.body}"\n[/Quoting]`
      : `\n\n[Replying to ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n${replyForwardAnnotation}${replyTarget.body}\n[/Replying]`
    : "";
  const forwardPrefix = forwardOrigin
    ? `[Forwarded from ${forwardOrigin.from}${
        forwardOrigin.date ? ` at ${new Date(forwardOrigin.date * 1000).toISOString()}` : ""
      }]\n`
    : "";
  const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : undefined;
  const senderName = buildSenderName(msg);
  const conversationLabel = isGroup
    ? (groupLabel ?? `group:${chatId}`)
    : buildSenderLabel(msg, senderId || chatId);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = formatInboundEnvelope({
    channel: "Telegram",
    from: conversationLabel,
    timestamp: msg.date ? msg.date * 1000 : undefined,
    body: `${forwardPrefix}${bodyText}${replySuffix}`,
    chatType: isGroup ? "group" : "direct",
    sender: {
      name: senderName,
      username: senderUsername || undefined,
      id: senderId || undefined,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  let combinedBody = body;
  if (isGroup && historyKey && historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Telegram",
          from: groupLabel ?? `group:${chatId}`,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
          chatType: "group",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
    groupConfig,
    topicConfig,
  });
  const commandBody = normalizeCommandBody(rawBody, {
    botUsername: primaryCtx.me?.username?.toLowerCase(),
  });
  const inboundHistory =
    isGroup && historyKey && historyLimit > 0
      ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;
  const currentMediaForContext = stickerCacheHit ? [] : allMedia;
  const contextMedia = [...currentMediaForContext, ...replyMedia];
  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: bodyText,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
    To: `telegram:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
    GroupSystemPrompt: isGroup || (!isGroup && groupConfig) ? groupSystemPrompt : undefined,
    SenderName: senderName,
    SenderId: senderId || undefined,
    SenderUsername: senderUsername || undefined,
    Provider: "telegram",
    Surface: "telegram",
    BotUsername: primaryCtx.me?.username ?? undefined,
    MessageSid: options?.messageIdOverride ?? String(msg.message_id),
    ReplyToId: replyTarget?.id,
    ReplyToBody: replyTarget?.body,
    ReplyToSender: replyTarget?.sender,
    ReplyToIsQuote: replyTarget?.kind === "quote" ? true : undefined,
    ReplyToForwardedFrom: replyTarget?.forwardedFrom?.from,
    ReplyToForwardedFromType: replyTarget?.forwardedFrom?.fromType,
    ReplyToForwardedFromId: replyTarget?.forwardedFrom?.fromId,
    ReplyToForwardedFromUsername: replyTarget?.forwardedFrom?.fromUsername,
    ReplyToForwardedFromTitle: replyTarget?.forwardedFrom?.fromTitle,
    ReplyToForwardedDate: replyTarget?.forwardedFrom?.date
      ? replyTarget.forwardedFrom.date * 1000
      : undefined,
    ForwardedFrom: forwardOrigin?.from,
    ForwardedFromType: forwardOrigin?.fromType,
    ForwardedFromId: forwardOrigin?.fromId,
    ForwardedFromUsername: forwardOrigin?.fromUsername,
    ForwardedFromTitle: forwardOrigin?.fromTitle,
    ForwardedFromSignature: forwardOrigin?.fromSignature,
    ForwardedFromChatType: forwardOrigin?.fromChatType,
    ForwardedFromMessageId: forwardOrigin?.fromMessageId,
    ForwardedDate: forwardOrigin?.date ? forwardOrigin.date * 1000 : undefined,
    Timestamp: msg.date ? msg.date * 1000 : undefined,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    MediaPath: contextMedia.length > 0 ? contextMedia[0]?.path : undefined,
    MediaType: contextMedia.length > 0 ? contextMedia[0]?.contentType : undefined,
    MediaUrl: contextMedia.length > 0 ? contextMedia[0]?.path : undefined,
    MediaPaths: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : undefined,
    MediaUrls: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : undefined,
    MediaTypes:
      contextMedia.length > 0
        ? (contextMedia.map((m) => m.contentType).filter(Boolean) as string[])
        : undefined,
    Sticker: allMedia[0]?.stickerMetadata,
    StickerMediaIncluded: allMedia[0]?.stickerMetadata ? !stickerCacheHit : undefined,
    ...(locationData ? toLocationContext(locationData) : undefined),
    CommandAuthorized: commandAuthorized,
    MessageThreadId: threadSpec.id,
    IsForum: isForum,
    OriginatingChannel: "telegram" as const,
    OriginatingTo: `telegram:${chatId}`,
  });

  const pinnedMainDmOwner = !isGroup
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: cfg.session?.dmScope,
        allowFrom: dmAllowFrom,
        normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0],
      })
    : null;
  const updateLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route,
    sessionKey: route.sessionKey,
  });

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: !isGroup
      ? {
          sessionKey: updateLastRouteSessionKey,
          channel: "telegram",
          to: `telegram:${chatId}`,
          accountId: route.accountId,
          threadId: dmThreadId != null ? String(dmThreadId) : undefined,
          mainDmOwnerPin:
            updateLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner && senderId
              ? {
                  ownerRecipient: pinnedMainDmOwner,
                  senderRecipient: senderId,
                  onSkip: ({ ownerRecipient, senderRecipient }) => {
                    logVerbose(
                      `telegram: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                    );
                  },
                }
              : undefined,
        }
      : undefined,
    onRecordError: (err) => {
      logVerbose(`telegram: failed updating session meta: ${String(err)}`);
    },
  });

  if (replyTarget && shouldLogVerbose()) {
    const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
    logVerbose(
      `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
    );
  }

  if (forwardOrigin && shouldLogVerbose()) {
    logVerbose(
      `telegram forward-context: forwardedFrom="${forwardOrigin.from}" type=${forwardOrigin.fromType}`,
    );
  }

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
    const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
    logVerbose(
      `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    skillFilter,
  };
}
