/**
 * Email Listener Skill - Email Parsing Module
 *
 * Parses raw IMAP message data into structured ParsedEmail objects.
 */

import type { ParsedEmail } from "./types.js";
import { logger } from "./logger.js";

/**
 * Parse an IMAP message into a ParsedEmail object
 */
export function parseEmail(message: Record<string, unknown>): ParsedEmail {
  const attributes = message.attributes as Record<string, unknown>;

  // Get message headers
  const header = message.parts?.[0]?.body as Record<string, string> | undefined;

  // Extract message ID
  const messageId = extractHeader(header, "message-id") || generateMessageId(attributes);

  // Extract sender information
  const from = extractHeader(header, "from") || "";
  const { email: sender, name: senderName } = parseFromHeader(from);

  // Extract subject
  const subject = extractHeader(header, "subject") || "";

  // Extract date
  const dateStr = extractHeader(header, "date");
  const timestamp = parseDate(dateStr);

  // Extract body
  const body = extractBody(message);

  logger.debug("Parsed email", {
    messageId,
    sender,
    subject: subject.substring(0, 50),
  });

  return {
    messageId,
    sender,
    senderName,
    subject,
    body,
    timestamp,
  };
}

/**
 * Extract a header value from the message headers
 */
function extractHeader(header: Record<string, string> | undefined, name: string): string {
  if (!header) return "";

  const value = header[name.toLowerCase()];
  if (!value) return "";

  // Handle multiple values (take first)
  const values = value.split(",");
  return values[0].trim();
}

/**
 * Parse the From header to extract email and name
 */
function parseFromHeader(from: string): { email: string; name: string } {
  // Handle "Name <email@example.com>" format
  const match = from.match(/^(?:.*?<)?([^>]+)>?$/);
  const email = match?.[1] || from;

  // Extract name if present
  const nameMatch = from.match(/^([^<]+)</);
  const name = nameMatch?.[1]?.trim() || "";

  return {
    email: email.toLowerCase().trim(),
    name,
  };
}

/**
 * Parse date string to Date object
 */
function parseDate(dateStr: string): Date {
  if (!dateStr) {
    return new Date();
  }

  try {
    // Try parsing as RFC 2822 date
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  } catch {
    // Fall through
  }

  return new Date();
}

/**
 * Extract body from the message
 */
function extractBody(message: Record<string, unknown>): string {
  // Try to get text body from parts
  const parts = message.parts as Array<{ which: string; body: string }> | undefined;

  if (!parts || parts.length === 0) {
    return "";
  }

  // Look for text/plain part
  for (const part of parts) {
    if (part.which === "TEXT") {
      return decodeBody(part.body);
    }
  }

  // Fall back to first part
  const firstPart = parts[0];
  if (firstPart) {
    return decodeBody(firstPart.body);
  }

  return "";
}

/**
 * Decode quoted-printable or base64 encoded body
 */
function decodeBody(body: string): string {
  if (!body) return "";

  try {
    // Handle quoted-printable encoding
    if (body.includes("=")) {
      // Simple quoted-printable decode
      let decoded = body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, hex) => {
          return String.fromCharCode(parseInt(hex, 16));
        });

      return decoded.trim();
    }

    return body.trim();
  } catch {
    return body;
  }
}

/**
 * Generate a message ID from attributes if not present
 */
function generateMessageId(attributes: Record<string, unknown>): string {
  const uid = attributes.uid || "unknown";
  const date = Date.now();
  return `<${uid}.${date}@frankos-email-listener>`;
}

/**
 * Check if email is a reply (has In-Reply-To or References)
 */
export function isReply(message: Record<string, unknown>): boolean {
  const header = message.parts?.[0]?.body as Record<string, string> | undefined;
  const inReplyTo = extractHeader(header, "in-reply-to");
  const references = extractHeader(header, "references");

  return !!(inReplyTo || references);
}

/**
 * Extract In-Reply-To message ID
 */
export function getInReplyToId(message: Record<string, unknown>): string | null {
  const header = message.parts?.[0]?.body as Record<string, string> | undefined;
  return extractHeader(header, "in-reply-to") || null;
}
