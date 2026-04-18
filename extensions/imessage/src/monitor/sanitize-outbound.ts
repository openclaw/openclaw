import { stripAssistantInternalScaffolding } from "openclaw/plugin-sdk/text-runtime";

/**
 * Patterns that indicate assistant-internal metadata leaked into text.
 * These must never reach a user-facing channel.
 */
const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
const ROLE_TURN_MARKER_RE = /\b(?:user|system|assistant)\s*:\s*$/gm;
const OPENCLAW_INTERNAL_BLOCK_RE =
  /(?:^|\n)\s*(?:Human:\s*)?(?:\[[^\n]*\]\s*)?<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\s*/g;
const OPENCLAW_INTERNAL_LINE_RE =
  /(?:^|\n)\s*(?:\[Inter-session message][^\n]*|OpenClaw runtime context \(internal\):|This context is runtime-generated, not user-authored\. Keep internal details private\.|sourceSession=[^\n]*|sourceChannel=[^\n]*|sourceTool=[^\n]*)(?=\n|$)/gim;

function stripSuspiciousIMessageTextArtifacts(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

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

  cleaned = cleaned.replace(OPENCLAW_INTERNAL_BLOCK_RE, "\n");
  cleaned = cleaned.replace(OPENCLAW_INTERNAL_LINE_RE, "\n");
  cleaned = cleaned.replace(INTERNAL_SEPARATOR_RE, "");
  cleaned = cleaned.replace(ASSISTANT_ROLE_MARKER_RE, "");
  cleaned = cleaned.replace(ROLE_TURN_MARKER_RE, "");
  cleaned = stripSuspiciousIMessageTextArtifacts(cleaned);

  // Collapse excessive blank lines left after stripping.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}

function closeDanglingCodeFence(text: string): string {
  if (!text) {
    return text;
  }
  const fenceCount = (text.match(/(^|\n)```/g) ?? []).length;
  return fenceCount % 2 === 0 ? text : `${text}\n\`\`\``;
}

export function normalizeIMessageDeliveryText(text: string): string {
  return closeDanglingCodeFence(sanitizeOutboundText(text ?? ""));
}
