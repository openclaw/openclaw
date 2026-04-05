import {
  findCodeRegions,
  isInsideCode,
  stripAssistantInternalScaffolding,
} from "openclaw/plugin-sdk/text-runtime";

/**
 * Patterns that indicate assistant-internal metadata leaked into text.
 * These must never reach a user-facing channel.
 */
const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*[^\s]+/gi;
const ROLE_TURN_MARKER_RE = /^(?:user|system|assistant)\s*:\s*$/gm;

function replaceOutsideCode(text: string, pattern: RegExp, replacement: string): string {
  pattern.lastIndex = 0;
  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (isInsideCode(index, codeRegions)) {
      continue;
    }
    result += text.slice(lastIndex, index);
    result += replacement;
    lastIndex = index + match[0].length;
  }

  if (!result && lastIndex === 0) {
    return text;
  }

  result += text.slice(lastIndex);
  return result;
}

/**
 * Strip assistant-internal scaffolding from outbound Discord text before delivery.
 * Applies reasoning/thinking tag removal, memory tag removal, and
 * model-specific internal separator stripping.
 */
export function sanitizeOutboundText(text: string): string {
  if (!text) {
    return text;
  }

  const leadingWhitespace = text.match(/^\s+/)?.[0] ?? "";
  const withoutLeadingWhitespace = leadingWhitespace ? text.slice(leadingWhitespace.length) : text;
  let cleaned = stripAssistantInternalScaffolding(text);

  // The shared stripper trims leading whitespace after removing scaffolding.
  // Put harmless indentation back when stripping the de-indented text produces
  // the same visible result, so ordinary indented replies stay unchanged.
  if (
    leadingWhitespace &&
    cleaned === stripAssistantInternalScaffolding(withoutLeadingWhitespace)
  ) {
    cleaned = `${leadingWhitespace}${cleaned}`;
  }

  cleaned = replaceOutsideCode(cleaned, INTERNAL_SEPARATOR_RE, "");
  cleaned = replaceOutsideCode(cleaned, ASSISTANT_ROLE_MARKER_RE, "");
  cleaned = replaceOutsideCode(cleaned, ROLE_TURN_MARKER_RE, "");

  // Collapse excessive blank lines left after stripping without eating
  // intentional leading indentation in user-visible content.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.replace(/^\n+/, "");
  cleaned = cleaned.trimEnd();

  return cleaned;
}
