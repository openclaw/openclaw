import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  normalizeLowercaseStringOrEmpty,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LEGACY_USER_JID_RE = /^(\d+)@c\.us$/i;
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;
const NON_WHATSAPP_PROVIDER_PREFIX_RE = /^[a-z][a-z0-9-]*:/i;
const WHATSAPP_NEWSLETTER_JID_RE = /^([0-9]+)@newsletter$/i;

function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

function normalizeWhatsAppGroupJid(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value)
    .replace(/^group:/i, "")
    .trim();
  const lower = normalizeLowercaseStringOrEmpty(candidate);
  if (!lower.endsWith("@g.us")) {
    return null;
  }
  const localPart = candidate.slice(0, candidate.length - "@g.us".length);
  if (!localPart || localPart.includes("@")) {
    return null;
  }
  return /^[0-9]+(-[0-9]+)*$/.test(localPart) ? `${localPart}@g.us` : null;
}

export function isWhatsAppGroupJid(value: string): boolean {
  return normalizeWhatsAppGroupJid(value) !== null;
}

export function isWhatsAppNewsletterJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return WHATSAPP_NEWSLETTER_JID_RE.test(candidate);
}

export function isWhatsAppUserTarget(value: string): boolean {
  return extractUserJidPhone(stripWhatsAppTargetPrefixes(value)) !== null;
}

function extractUserJidPhone(jid: string): string | null {
  return (
    (jid.match(WHATSAPP_USER_JID_RE) ??
      jid.match(WHATSAPP_LEGACY_USER_JID_RE) ??
      jid.match(WHATSAPP_LID_RE))?.[1] ?? null
  );
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }
  const groupJid = normalizeWhatsAppGroupJid(candidate);
  if (groupJid) {
    return groupJid;
  }
  const newsletterMatch = candidate.match(WHATSAPP_NEWSLETTER_JID_RE);
  if (newsletterMatch) {
    return `${newsletterMatch[1]}@newsletter`;
  }
  const phone = extractUserJidPhone(candidate);
  if (phone) {
    const normalized = normalizeE164(phone);
    return normalized.length > 1 ? normalized : null;
  }
  if (candidate.includes("@")) {
    return null;
  }
  if (NON_WHATSAPP_PROVIDER_PREFIX_RE.test(candidate)) {
    return null;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : null;
}

export function normalizeWhatsAppMessagingTarget(raw: string): string | undefined {
  return normalizeWhatsAppTarget(raw) ?? undefined;
}

export function normalizeWhatsAppAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return uniqueStrings(
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeWhatsAppAllowFromEntry,
    }),
  );
}

export function normalizeWhatsAppAllowFromEntry(entry: string): string | null {
  if (entry === "*") {
    return entry;
  }
  const normalized = normalizeWhatsAppTarget(entry);
  if (!normalized) {
    return null;
  }
  return normalized.startsWith("+") ? normalized.slice(1) : normalized;
}

export function looksLikeWhatsAppTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  return /^whatsapp:/i.test(trimmed) || normalizeWhatsAppTarget(trimmed) !== null;
}
