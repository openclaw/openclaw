/**
 * Inbound email → MsgContext mapping.
 * Converts InboxAPI emails into the format expected by OpenClaw's routing.
 */

import {
  deriveSessionKey,
  extractSenderEmail,
  extractSenderName,
  getThreadRootId,
} from "./threading.js";
import type { InboxApiEmail } from "./types.js";

const CHANNEL_ID = "inboxapi";

export interface InboundEmailContext {
  body: string;
  from: string;
  senderName: string;
  sessionKey: string;
  conversationLabel: string;
  currentMessageId: string;
  /** InboxAPI internal ID for replying */
  replyToInternalId: string;
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
    // Use InboxAPI internal ID for reply operations (not RFC Message-ID)
    replyToInternalId: email.id,
    chatType: "direct",
  };
}

/**
 * Build the full MsgContext fields for SDK finalizeInboundContext.
 */
export function buildInboundMsgFields(
  email: InboxApiEmail,
  accountId: string,
  commandAuthorized: boolean,
) {
  const ctx = mapEmailToInbound(email);
  const ts = Date.parse(email.date);
  const threadRootId = getThreadRootId(email);
  return {
    Body: ctx.body,
    RawBody: ctx.body,
    CommandBody: ctx.body,
    From: `${CHANNEL_ID}:${ctx.from}`,
    To: `${CHANNEL_ID}:${Array.isArray(email.to) ? email.to[0] : email.to}`,
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
    Timestamp: Number.isFinite(ts) ? ts : Date.now(),
    CurrentMessageId: ctx.currentMessageId,
    // Store the InboxAPI internal ID for reply operations
    ReplyToId: ctx.replyToInternalId,
    MessageSid: email.id,
    MessageSidFull: email.messageId,
    MessageThreadId: threadRootId,
    CommandAuthorized: commandAuthorized,
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
