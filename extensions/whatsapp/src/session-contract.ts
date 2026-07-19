// Whatsapp plugin module implements session contract behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { canonicalizeWhatsAppGroupJid } from "./whatsapp-jid-syntax.js";

function extractLegacyWhatsAppGroupId(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  const normalizedKey = trimmed.toLowerCase();
  if (normalizedKey.startsWith("group:")) {
    return canonicalizeWhatsAppGroupJid(trimmed.slice("group:".length));
  }
  if (!trimmed.includes(":")) {
    return canonicalizeWhatsAppGroupJid(trimmed);
  }
  if (normalizedKey.startsWith("whatsapp:") && !normalizedKey.includes(":group:")) {
    const remainder = trimmed.slice("whatsapp:".length).trim();
    const cleaned = remainder.replace(/^group:/i, "").trim();
    return canonicalizeWhatsAppGroupJid(cleaned);
  }
  return null;
}

export function isLegacyGroupSessionKey(key: string): boolean {
  return extractLegacyWhatsAppGroupId(key) !== null;
}

export function deriveLegacySessionChatType(key: string): "group" | undefined {
  return isLegacyGroupSessionKey(key) ? "group" : undefined;
}

export function canonicalizeLegacySessionKey(params: {
  key: string;
  agentId: string;
}): string | null {
  const legacyGroupId = extractLegacyWhatsAppGroupId(params.key);
  return legacyGroupId
    ? `agent:${normalizeLowercaseStringOrEmpty(params.agentId)}:whatsapp:group:${legacyGroupId}`
    : null;
}
