/**
 * Inbound email → MsgContext mapping.
 * Converts InboxAPI emails into the format expected by OpenClaw's routing.
 */

import { deriveSessionKey, extractSenderEmail, extractSenderName } from "./threading.js";
import type { InboxApiEmail } from "./types.js";

const CHANNEL_ID = "inboxapi";

export interface InboundEmailContext {
  body: string;
  from: string;
  senderName: string;
  sessionKey: string;
  conversationLabel: string;
  currentMessageId: string;
  replyToId?: string;
  chatType: "direct";
}

/**
 * Map an InboxAPI email to an inbound message context.
 */
export function mapEmailToInbound(email: InboxApiEmail): InboundEmailContext {
  const senderEmail = extractSenderEmail(email.from);
  const senderName = email.fromName || extractSenderName(email.from) || senderEmail;

  // Prefer plain text body; strip HTML tags as fallback
  let body = email.text ?? "";
  if (!body && email.html) {
    body = stripHtml(email.html);
  }

  return {
    body,
    from: senderEmail,
    senderName,
    sessionKey: deriveSessionKey(email),
    conversationLabel: email.subject || "(no subject)",
    currentMessageId: email.messageId,
    replyToId: email.inReplyTo,
    chatType: "direct",
  };
}

/**
 * Build the full MsgContext fields for SDK finalizeInboundContext.
 */
export function buildInboundMsgFields(email: InboxApiEmail, accountId: string) {
  const ctx = mapEmailToInbound(email);
  return {
    Body: ctx.body,
    RawBody: ctx.body,
    CommandBody: ctx.body,
    From: `${CHANNEL_ID}:${ctx.from}`,
    To: `${CHANNEL_ID}:${ctx.from}`,
    SessionKey: ctx.sessionKey,
    AccountId: accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${ctx.from}`,
    ChatType: ctx.chatType,
    SenderName: ctx.senderName,
    SenderId: ctx.from,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ConversationLabel: ctx.conversationLabel,
    Timestamp: new Date(email.date).getTime() || Date.now(),
    CurrentMessageId: ctx.currentMessageId,
    ReplyToId: ctx.replyToId,
    CommandAuthorized: true,
  };
}

/** Simple HTML tag stripper for fallback text extraction */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
