/**
 * Email thread → session key mapping.
 * Uses the thread root Message-ID to derive a stable session key.
 */

import { createHash } from "node:crypto";
import type { InboxApiEmail } from "./types.js";

/**
 * Derive the thread root Message-ID from email headers.
 * Resolution: first entry in References → In-Reply-To → self Message-ID
 */
export function getThreadRootId(email: InboxApiEmail): string {
  // References header lists the full thread chain; first entry is the root
  if (email.references && email.references.length > 0) {
    return email.references[0];
  }
  // In-Reply-To points to the parent (often the root for simple threads)
  if (email.inReplyTo) {
    return email.inReplyTo;
  }
  // Self Message-ID (this is a new thread)
  return email.messageId;
}

/**
 * Derive a stable session key from an email's thread root.
 * Format: inboxapi-<sha256-prefix>
 */
export function deriveSessionKey(email: InboxApiEmail): string {
  const rootId = getThreadRootId(email);
  const hash = createHash("sha256").update(rootId).digest("hex").slice(0, 16);
  return `inboxapi-${hash}`;
}

/**
 * Extract the sender email address from a From header value.
 * Handles formats like "Name <email@example.com>" or plain "email@example.com"
 */
export function extractSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  return from.toLowerCase().trim();
}

/**
 * Extract the sender display name from a From header value.
 */
export function extractSenderName(from: string): string {
  const match = from.match(/^(.+?)\s*<[^>]+>/);
  if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  return "";
}
