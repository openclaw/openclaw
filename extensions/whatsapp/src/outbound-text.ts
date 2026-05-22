import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripToolCallXmlTags,
} from "openclaw/plugin-sdk/text-chunking";

function stripWhatsAppPluralToolXml(text: string): string {
  return stripToolCallXmlTags(text, { stripFunctionCallsXmlPayloads: true });
}

function finalizeWhatsAppVisibleText(text: string): string {
  return sanitizeForPlainText(stripWhatsAppPluralToolXml(text));
}

export function normalizeWhatsAppPayloadText(text: string | undefined): string {
  return finalizeWhatsAppVisibleText(sanitizeAssistantVisibleText(text ?? "")).trimStart();
}

function stripLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function normalizeWhatsAppPayloadTextPreservingIndentation(
  text: string | undefined,
): string {
  const sanitized = sanitizeAssistantVisibleTextWithProfile(
    stripLeadingBlankLines(text ?? ""),
    "history",
  );
  const normalized = stripLeadingBlankLines(finalizeWhatsAppVisibleText(sanitized));
  return normalized.trim() ? normalized : "";
}
