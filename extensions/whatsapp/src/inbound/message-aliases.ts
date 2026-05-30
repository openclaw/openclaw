import type {
  LegacyFlatWebInboundMessage,
  WebInboundCallbackMessage,
  WebInboundMessage,
  WebInboundMessageInput,
  WhatsAppInboundGroupContext,
  WhatsAppInboundQuote,
} from "./types.js";

type QuoteSender = NonNullable<WhatsAppInboundQuote["sender"]>;

function normalizeQuoteSender(sender: QuoteSender | undefined): QuoteSender | undefined {
  if (!sender?.displayName && !sender?.jid && !sender?.e164) {
    return undefined;
  }
  return sender;
}

function buildQuoteFromFlatAliases(
  msg: LegacyFlatWebInboundMessage,
): WhatsAppInboundQuote | undefined {
  if (msg.replyTo) {
    return {
      context: msg.replyTo,
      id: msg.replyTo.id,
      body: msg.replyTo.body,
      sender: normalizeQuoteSender({
        displayName: msg.replyTo.sender?.label ?? msg.replyToSender,
        jid: msg.replyTo.sender?.jid ?? msg.replyToSenderJid,
        e164: msg.replyTo.sender?.e164 ?? msg.replyToSenderE164,
      }),
    };
  }
  if (
    !msg.replyToId &&
    !msg.replyToBody &&
    !msg.replyToSender &&
    !msg.replyToSenderJid &&
    !msg.replyToSenderE164
  ) {
    return undefined;
  }
  return {
    id: msg.replyToId,
    body: msg.replyToBody,
    sender: normalizeQuoteSender({
      displayName: msg.replyToSender,
      jid: msg.replyToSenderJid,
      e164: msg.replyToSenderE164,
    }),
  };
}

function buildGroupFromFlatAliases(
  msg: LegacyFlatWebInboundMessage,
): WhatsAppInboundGroupContext | undefined {
  const mentionJids = msg.mentions ?? msg.mentionedJids;
  if (!msg.groupSubject && !msg.groupParticipants?.length && !mentionJids?.length) {
    return undefined;
  }
  return {
    subject: msg.groupSubject,
    participants: msg.groupParticipants,
    mentions: mentionJids?.length ? { jids: mentionJids } : undefined,
  };
}

export function withDeprecatedWebInboundMessageFlatAliases<T extends WebInboundCallbackMessage>(
  msg: T,
): T & WebInboundMessage {
  // Keep the shipped callback shape alive while nested contexts remain canonical.
  return {
    ...msg,
    id: msg.event.id,
    to: msg.platform.recipientJid,
    body: msg.payload.body,
    pushName: msg.platform.pushName,
    timestamp: msg.event.timestamp,
    chatId: msg.platform.chatJid,
    sender: msg.platform.sender,
    senderJid: msg.platform.senderJid,
    senderE164: msg.platform.senderE164,
    senderName: msg.platform.senderName,
    replyTo: msg.quote?.context,
    replyToId: msg.quote?.id ?? msg.quote?.context?.id,
    replyToBody: msg.quote?.body ?? msg.quote?.context?.body,
    replyToSender: msg.quote?.context?.sender?.label ?? msg.quote?.sender?.displayName,
    replyToSenderJid: msg.quote?.context?.sender?.jid ?? msg.quote?.sender?.jid,
    replyToSenderE164: msg.quote?.context?.sender?.e164 ?? msg.quote?.sender?.e164,
    groupSubject: msg.group?.subject,
    groupParticipants: msg.group?.participants,
    mentions: msg.group?.mentions?.jids,
    mentionedJids: msg.group?.mentions?.jids,
    self: msg.platform.self,
    selfJid: msg.platform.selfJid,
    selfLid: msg.platform.selfLid,
    selfE164: msg.platform.selfE164,
    fromMe: msg.platform.fromMe,
    location: msg.payload.location,
    sendComposing: msg.platform.sendComposing,
    reply: msg.platform.reply,
    sendMedia: msg.platform.sendMedia,
    mediaPath: msg.payload.media?.path,
    mediaType: msg.payload.media?.type,
    mediaFileName: msg.payload.media?.fileName,
    mediaUrl: msg.payload.media?.url,
    untrustedStructuredContext: msg.payload.untrustedStructuredContext,
    isBatched: msg.event.isBatched,
  };
}

function normalizeLegacyFlatWebInboundMessage(msg: LegacyFlatWebInboundMessage): WebInboundMessage {
  const media =
    msg.mediaPath || msg.mediaType || msg.mediaFileName || msg.mediaUrl
      ? {
          path: msg.mediaPath,
          type: msg.mediaType,
          fileName: msg.mediaFileName,
          url: msg.mediaUrl,
        }
      : undefined;
  return withDeprecatedWebInboundMessageFlatAliases({
    ...msg,
    event: {
      id: msg.id,
      timestamp: msg.timestamp,
      isBatched: msg.isBatched,
    },
    payload: {
      body: msg.body,
      media,
      location: msg.location,
      untrustedStructuredContext: msg.untrustedStructuredContext,
    },
    platform: {
      chatJid: msg.chatId,
      recipientJid: msg.to,
      sender: msg.sender,
      senderJid: msg.senderJid,
      senderE164: msg.senderE164,
      senderName: msg.senderName,
      pushName: msg.pushName,
      self: msg.self,
      selfJid: msg.selfJid,
      selfLid: msg.selfLid,
      selfE164: msg.selfE164,
      fromMe: msg.fromMe,
      sendComposing: msg.sendComposing,
      reply: msg.reply,
      sendMedia: msg.sendMedia,
    },
    quote: buildQuoteFromFlatAliases(msg),
    group: buildGroupFromFlatAliases(msg),
  });
}

export function normalizeWebInboundMessage(msg: WebInboundMessageInput): WebInboundMessage {
  if (msg.event && msg.payload && msg.platform) {
    return withDeprecatedWebInboundMessageFlatAliases(msg);
  }

  if (msg.event || msg.payload || msg.platform || msg.quote || msg.group) {
    throw new Error(
      "WhatsApp inbound messages must be either legacy flat or canonical nested; partial nested contexts are not supported.",
    );
  }

  return normalizeLegacyFlatWebInboundMessage(msg);
}
