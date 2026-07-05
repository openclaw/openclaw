// Imessage plugin module implements sanitize outbound behavior.
import { stripAssistantInternalScaffolding } from "openclaw/plugin-sdk/text-chunking";

/**
 * Patterns that indicate assistant-internal metadata leaked into text.
 * These must never reach a user-facing channel.
 */
const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
<<<<<<< HEAD
// Only a standalone role marker on its own line (a leaked turn boundary) — not
// any line that merely ends with the word "user/system/assistant:" in prose.
const ROLE_TURN_MARKER_RE = /^[ \t]*(?:user|system|assistant)\s*:\s*$/gm;
=======
const ROLE_TURN_MARKER_RE = /\b(?:user|system|assistant)\s*:\s*$/gm;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

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

  // Collapse excessive blank lines left after stripping.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}
