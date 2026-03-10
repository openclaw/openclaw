import { stripAssistantInternalScaffolding } from "../../../../src/shared/text/assistant-visible-text.js";

/**
 * Patterns that indicate assistant-internal metadata leaked into text.
 * These must never reach a user-facing channel.
 */
const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
const ROLE_TURN_MARKER_RE = /\b(?:user|system|assistant)\s*:\s*$/gm;
// Matches [[reply_to:ID]] and [[reply_to_current]] directive tags.
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

/**
 * Strip all assistant-internal scaffolding from outbound text before delivery.
 * Applies reasoning/thinking tag removal, memory tag removal, and
 * model-specific internal separator stripping.
 */
export function sanitizeOutboundText(text: string): string {
  if (!text) {
    return text;
  }

  let cleaned = stripAssistantInternalScaffolding(text);

  cleaned = cleaned.replace(INTERNAL_SEPARATOR_RE, "");
  cleaned = cleaned.replace(ASSISTANT_ROLE_MARKER_RE, "");
  cleaned = cleaned.replace(ROLE_TURN_MARKER_RE, "");
  cleaned = cleaned.replace(REPLY_TAG_RE, "");

  // Collapse excessive blank lines left after stripping.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}
