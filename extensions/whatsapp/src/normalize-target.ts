import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted|lid|hosted\.lid)$/i;
const WHATSAPP_LEGACY_USER_JID_RE = /^(\d+)@c\.us$/i;
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

function normalizeWhatsAppGroupJid(candidate: string): string | null {
  const match = /^(\d+(?:-\d+)*)@g\.us$/i.exec(candidate.replace(/^group:/i, "").trim());
  return match ? `${match[1]}@g.us` : null;
}

export function isWhatsAppGroupJid(value: string): boolean {
  return normalizeWhatsAppGroupJid(stripWhatsAppTargetPrefixes(value)) !== null;
}

export function isWhatsAppNewsletterJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return WHATSAPP_NEWSLETTER_JID_RE.test(candidate);
}

export function isWhatsAppUserTarget(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return WHATSAPP_USER_JID_RE.test(candidate) || WHATSAPP_LEGACY_USER_JID_RE.test(candidate);
}

/** Policy identity and delivery input must be derived from the same address parse. */
export function parseWhatsAppTarget(value: string): {
  normalizedTarget: string;
  deliveryTarget: string;
} | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }
  const groupJid = normalizeWhatsAppGroupJid(candidate);
  if (groupJid) {
    return { normalizedTarget: groupJid, deliveryTarget: groupJid };
  }
  const newsletterMatch = candidate.match(WHATSAPP_NEWSLETTER_JID_RE);
  if (newsletterMatch) {
    const jid = `${newsletterMatch[1]}@newsletter`;
    return { normalizedTarget: jid, deliveryTarget: jid };
  }
  const directMatch = candidate.match(WHATSAPP_USER_JID_RE);
  const localPart = directMatch?.[1];
  const server = directMatch?.[2]?.toLowerCase();
  if (localPart && server) {
    const normalizedTarget =
      server === "lid" || server === "hosted.lid"
        ? `${localPart}@${server}`
        : normalizeE164(localPart);
    return {
      normalizedTarget,
      // Ordinary phone JIDs must still pass through the phone-to-LID mapping.
      deliveryTarget: server === "s.whatsapp.net" ? normalizedTarget : candidate,
    };
  }
  const legacyPhone = candidate.match(WHATSAPP_LEGACY_USER_JID_RE)?.[1];
  if (
    !legacyPhone &&
    (candidate.includes("@") || NON_WHATSAPP_PROVIDER_PREFIX_RE.test(candidate))
  ) {
    return null;
  }
  const normalizedTarget = normalizeE164(legacyPhone ?? candidate);
  return normalizedTarget.length > 1
    ? { normalizedTarget, deliveryTarget: normalizedTarget }
    : null;
}

export function normalizeWhatsAppTarget(value: string): string | null {
  return parseWhatsAppTarget(value)?.normalizedTarget ?? null;
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
