import { stripAssistantInternalScaffolding } from "../../../../src/shared/text/assistant-visible-text.js";
const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
const ROLE_TURN_MARKER_RE = /\b(?:user|system|assistant)\s*:\s*$/gm;
function sanitizeOutboundText(text) {
  if (!text) {
    return text;
  }
  let cleaned = stripAssistantInternalScaffolding(text);
  cleaned = cleaned.replace(INTERNAL_SEPARATOR_RE, "");
  cleaned = cleaned.replace(ASSISTANT_ROLE_MARKER_RE, "");
  cleaned = cleaned.replace(ROLE_TURN_MARKER_RE, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}
export {
  sanitizeOutboundText
};
