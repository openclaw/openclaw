// Whatsapp plugin module owns dependency-light allowlist formatting.
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  parseWhatsAppDirectJidSyntax,
  stripWhatsAppTargetPrefixes,
} from "./whatsapp-jid-syntax.js";

const NON_WHATSAPP_PROVIDER_PREFIX_RE = /^[a-z][a-z0-9-]*:/i;

export function normalizeWhatsAppAllowFromEntry(entry: string): string | null {
  if (entry === "*") {
    return entry;
  }
  const candidate = stripWhatsAppTargetPrefixes(entry);
  const directJid = parseWhatsAppDirectJidSyntax(candidate);
  if (directJid) {
    if (directJid.server !== "s.whatsapp.net" && directJid.server !== "hosted") {
      return null;
    }
    return directJid.user;
  }
  if (candidate.includes("@") || NON_WHATSAPP_PROVIDER_PREFIX_RE.test(candidate)) {
    return null;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized.slice(1) : null;
}

export function formatWhatsAppConfigAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return uniqueStrings(
    normalizeStringEntries(allowFrom)
      .map(normalizeWhatsAppAllowFromEntry)
      .filter((entry): entry is string => entry !== null),
  );
}

export const normalizeWhatsAppAllowFromEntries = formatWhatsAppConfigAllowFromEntries;
