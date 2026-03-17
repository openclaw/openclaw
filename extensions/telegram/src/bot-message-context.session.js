import { normalizeCommandBody } from "../../../src/auto-reply/commands-registry.js";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions
} from "../../../src/auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap
} from "../../../src/auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import { toLocationContext } from "../../../src/channels/location.js";
import { recordInboundSession } from "../../../src/channels/session.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../../src/config/sessions.js";
import { logVerbose, shouldLogVerbose } from "../../../src/globals.js";
import { resolveInboundLastRouteSessionKey } from "../../../src/routing/resolve-route.js";
import { resolvePinnedMainDmOwnerFromAllowlist } from "../../../src/security/dm-policy-shared.js";
import { normalizeAllowFrom } from "./bot-access.js";
import {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  describeReplyTarget,
  normalizeForwardedContext
} from "./bot/helpers.js";
import { resolveTelegramGroupPromptSettings } from "./group-config-helpers.js";
async function buildTelegramInboundContextPayload(params) {
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
    dmAllowFrom
  } = params;
  const replyTarget = describeReplyTarget(msg);
  const forwardOrigin = normalizeForwardedContext(msg);
  const replyForwardAnnotation = replyTarget?.forwardedFrom ? `[Forwarded from ${replyTarget.forwardedFrom.from}${replyTarget.forwardedFrom.date ? ` at ${new Date(replyTarget.forwardedFrom.date * 1e3).toISOString()}` : ""}]
` : "";
  const replySuffix = replyTarget ? replyTarget.kind === "quote" ? `

[Quoting ${replyTarget.sender}${replyTarget.id ? ` id:${replyTarget.id}` : ""}]
${replyForwardAnnotation}"${replyTarget.body}"
[/Quoting]` : `

[Replying to ${replyTarget.sender}${replyTarget.id ? ` id:${replyTarget.id}` : ""}]
${replyForwardAnnotation}${replyTarget.body}
[/Replying]` : "";
  const forwardPrefix = forwardOrigin ? `[Forwarded from ${forwardOrigin.from}${forwardOrigin.date ? ` at ${new Date(forwardOrigin.date * 1e3).toISOString()}` : ""}]
` : "";
  const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : void 0;
  const senderName = buildSenderName(msg);
  const conversationLabel = isGroup ? groupLabel ?? `group:${chatId}` : buildSenderLabel(msg, senderId || chatId);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey
  });
  const body = formatInboundEnvelope({
    channel: "Telegram",
    from: conversationLabel,
    timestamp: msg.date ? msg.date * 1e3 : void 0,
    body: `${forwardPrefix}${bodyText}${replySuffix}`,
    chatType: isGroup ? "group" : "direct",
    sender: {
      name: senderName,
      username: senderUsername || void 0,
      id: senderId || void 0
    },
    previousTimestamp,
    envelope: envelopeOptions
  });
  let combinedBody = body;
  if (isGroup && historyKey && historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) => formatInboundEnvelope({
        channel: "Telegram",
        from: groupLabel ?? `group:${chatId}`,
        timestamp: entry.timestamp,
        body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
        chatType: "group",
        senderLabel: entry.sender,
        envelope: envelopeOptions
      })
    });
  }
  const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
    groupConfig,
    topicConfig
  });
  const commandBody = normalizeCommandBody(rawBody, {
    botUsername: primaryCtx.me?.username?.toLowerCase()
  });
  const inboundHistory = isGroup && historyKey && historyLimit > 0 ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
    sender: entry.sender,
    body: entry.body,
    timestamp: entry.timestamp
  })) : void 0;
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
    GroupSubject: isGroup ? msg.chat.title ?? void 0 : void 0,
    GroupSystemPrompt: isGroup || !isGroup && groupConfig ? groupSystemPrompt : void 0,
    SenderName: senderName,
    SenderId: senderId || void 0,
    SenderUsername: senderUsername || void 0,
    Provider: "telegram",
    Surface: "telegram",
    BotUsername: primaryCtx.me?.username ?? void 0,
    MessageSid: options?.messageIdOverride ?? String(msg.message_id),
    ReplyToId: replyTarget?.id,
    ReplyToBody: replyTarget?.body,
    ReplyToSender: replyTarget?.sender,
    ReplyToIsQuote: replyTarget?.kind === "quote" ? true : void 0,
    ReplyToForwardedFrom: replyTarget?.forwardedFrom?.from,
    ReplyToForwardedFromType: replyTarget?.forwardedFrom?.fromType,
    ReplyToForwardedFromId: replyTarget?.forwardedFrom?.fromId,
    ReplyToForwardedFromUsername: replyTarget?.forwardedFrom?.fromUsername,
    ReplyToForwardedFromTitle: replyTarget?.forwardedFrom?.fromTitle,
    ReplyToForwardedDate: replyTarget?.forwardedFrom?.date ? replyTarget.forwardedFrom.date * 1e3 : void 0,
    ForwardedFrom: forwardOrigin?.from,
    ForwardedFromType: forwardOrigin?.fromType,
    ForwardedFromId: forwardOrigin?.fromId,
    ForwardedFromUsername: forwardOrigin?.fromUsername,
    ForwardedFromTitle: forwardOrigin?.fromTitle,
    ForwardedFromSignature: forwardOrigin?.fromSignature,
    ForwardedFromChatType: forwardOrigin?.fromChatType,
    ForwardedFromMessageId: forwardOrigin?.fromMessageId,
    ForwardedDate: forwardOrigin?.date ? forwardOrigin.date * 1e3 : void 0,
    Timestamp: msg.date ? msg.date * 1e3 : void 0,
    WasMentioned: isGroup ? effectiveWasMentioned : void 0,
    MediaPath: contextMedia.length > 0 ? contextMedia[0]?.path : void 0,
    MediaType: contextMedia.length > 0 ? contextMedia[0]?.contentType : void 0,
    MediaUrl: contextMedia.length > 0 ? contextMedia[0]?.path : void 0,
    MediaPaths: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : void 0,
    MediaUrls: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : void 0,
    MediaTypes: contextMedia.length > 0 ? contextMedia.map((m) => m.contentType).filter(Boolean) : void 0,
    Sticker: allMedia[0]?.stickerMetadata,
    StickerMediaIncluded: allMedia[0]?.stickerMetadata ? !stickerCacheHit : void 0,
    ...locationData ? toLocationContext(locationData) : void 0,
    CommandAuthorized: commandAuthorized,
    MessageThreadId: threadSpec.id,
    IsForum: isForum,
    OriginatingChannel: "telegram",
    OriginatingTo: `telegram:${chatId}`
  });
  const pinnedMainDmOwner = !isGroup ? resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: cfg.session?.dmScope,
    allowFrom: dmAllowFrom,
    normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0]
  }) : null;
  const updateLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route,
    sessionKey: route.sessionKey
  });
  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: !isGroup ? {
      sessionKey: updateLastRouteSessionKey,
      channel: "telegram",
      to: `telegram:${chatId}`,
      accountId: route.accountId,
      threadId: dmThreadId != null ? String(dmThreadId) : void 0,
      mainDmOwnerPin: updateLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner && senderId ? {
        ownerRecipient: pinnedMainDmOwner,
        senderRecipient: senderId,
        onSkip: ({ ownerRecipient, senderRecipient }) => {
          logVerbose(
            `telegram: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`
          );
        }
      } : void 0
    } : void 0,
    onRecordError: (err) => {
      logVerbose(`telegram: failed updating session meta: ${String(err)}`);
    }
  });
  if (replyTarget && shouldLogVerbose()) {
    const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
    logVerbose(
      `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`
    );
  }
  if (forwardOrigin && shouldLogVerbose()) {
    logVerbose(
      `telegram forward-context: forwardedFrom="${forwardOrigin.from}" type=${forwardOrigin.fromType}`
    );
  }
  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
    const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
    logVerbose(
      `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`
    );
  }
  return {
    ctxPayload,
    skillFilter
  };
}
export {
  buildTelegramInboundContextPayload
};
