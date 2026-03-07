// Webhook signature verification + event parsing

import { createHmac } from "node:crypto";
import type { ViberWebhookEvent } from "./types.js";

/**
 * Verify Viber webhook signature using HMAC-SHA256.
 * The signature is the HMAC-SHA256 of the raw request body using the bot token as key.
 */
export function verifySignature(
  body: string | Buffer,
  token: string,
  signature: string,
): boolean {
  const expectedSignature = createHmac("sha256", token)
    .update(body)
    .digest("hex");
  return expectedSignature === signature.toLowerCase();
}

/**
 * Parse a webhook event from the raw request body.
 */
export function parseWebhookEvent(body: string): ViberWebhookEvent | null {
  try {
    return JSON.parse(body) as ViberWebhookEvent;
  } catch {
    return null;
  }
}

/**
 * Check if an event is a message event that should be processed.
 */
export function isMessageEvent(event: ViberWebhookEvent): boolean {
  return event.event === "message" && !!event.sender && !!event.message;
}

/**
 * Check if an event is a conversation_started event (new user).
 */
export function isConversationStarted(event: ViberWebhookEvent): boolean {
  return event.event === "conversation_started" && !!event.user;
}

/**
 * Extract text content from a Viber message event.
 */
export function extractMessageText(event: ViberWebhookEvent): string {
  if (!event.message) return "";

  switch (event.message.type) {
    case "text":
      return event.message.text ?? "";
    case "picture":
      return event.message.text ?? "[Image]";
    case "video":
      return event.message.text ?? "[Video]";
    case "file":
      return `[File: ${event.message.file_name ?? "unknown"}]`;
    case "sticker":
      return "[Sticker]";
    case "contact":
      return `[Contact: ${event.message.contact?.name ?? "unknown"}]`;
    case "url":
      return event.message.media ?? "[URL]";
    case "location":
      return `[Location: ${event.message.location?.lat}, ${event.message.location?.lon}]`;
    default:
      return event.message.text ?? "";
  }
}

/**
 * Convert OpenClaw markdown to Viber-friendly plain text.
 * Viber doesn't support markdown in messages, so we strip/convert formatting.
 */
export function markdownToViber(text: string): string {
  let result = text;

  // Convert bold **text** or __text__ to *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Convert strikethrough ~~text~~ to ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Convert headers # to text with emphasis
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Convert links [text](url) to "text (url)"
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Convert images ![alt](url) to "[Image: alt] url"
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[Image: $1] $2");

  // Convert horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, "————————");

  // Convert blockquotes > text to "| text"
  result = result.replace(/^>\s?(.+)$/gm, "│ $1");

  // Convert unordered lists - item to • item
  result = result.replace(/^[-*+]\s+/gm, "• ");

  return result;
}
