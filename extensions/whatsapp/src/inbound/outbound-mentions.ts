import type { AnyMessageContent } from "baileys";
import { isInsideCode, type CodeRegion } from "openclaw/plugin-sdk/text-chunking";

export type WhatsAppOutboundMentionParticipant =
  | string
  | {
      id?: string | null;
      lid?: string | null;
      phoneNumber?: string | null;
      e164?: string | null;
    };

export type WhatsAppOutboundMentionResolution = {
  text: string;
  mentionedJids: string[];
};

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /(?<=(?:^|[^\\])(?:\\\\)*)(`+)[\s\S]*?(?:(?<!`)\1(?!`)|$)/g;
const OUTBOUND_MENTION_RE = /@(\+?\d+)/g;
const KNOWN_USER_JID_RE = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted|lid|hosted\.lid|c\.us)$/i;
const PHONE_JID_DOMAIN_RE = /^(s\.whatsapp\.net|hosted|c\.us)$/i;
const LID_JID_DOMAIN_RE = /^(lid|hosted\.lid)$/i;

type MentionTarget = {
  mentionJid: string;
  replacementText?: string;
};

export function mayContainWhatsAppOutboundMention(text: string): boolean {
  return /@\+?\d/.test(text);
}

function collectCodeRanges(text: string): CodeRegion[] {
  const ranges: CodeRegion[] = [];
  for (const match of text.matchAll(CODE_FENCE_RE)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(INLINE_CODE_RE)) {
    const start = match.index;
    if (isInsideCode(start, ranges)) {
      continue;
    }
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges.toSorted((a, b) => a.start - b.start);
}

function normalizeKnownUserJid(value: string): string | null {
  const trimmed = value.replace(/^whatsapp:/i, "").trim();
  const jidMatch = trimmed.match(KNOWN_USER_JID_RE);
  if (jidMatch) {
    const user = jidMatch[1];
    const rawDomain = jidMatch[2];
    if (!user || !rawDomain) {
      return null;
    }
    const domain = rawDomain.toLowerCase() === "c.us" ? "s.whatsapp.net" : rawDomain.toLowerCase();
    return `${user}@${domain}`;
  }
  const digits = trimmed.startsWith("+")
    ? trimmed.replace(/\D/g, "")
    : /^\d+$/.test(trimmed)
      ? trimmed
      : "";
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function extractKnownJidParts(value: string): { user: string; domain: string } | null {
  const normalized = normalizeKnownUserJid(value);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/^(\d+)@(.+)$/);
  const user = match?.[1];
  const domain = match?.[2];
  return user && domain ? { user, domain } : null;
}

function extractPhoneDigits(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.replace(/^whatsapp:/i, "").trim();
  if (trimmed.startsWith("+") || /^\d+$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    return digits || null;
  }
  const parts = extractKnownJidParts(trimmed);
  return parts && PHONE_JID_DOMAIN_RE.test(parts.domain) ? parts.user : null;
}

function extractLidDigits(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parts = extractKnownJidParts(value);
  return parts && LID_JID_DOMAIN_RE.test(parts.domain) ? parts.user : null;
}

function chooseMentionJid(
  values: Exclude<WhatsAppOutboundMentionParticipant, string>,
): string | null {
  const idJid = normalizeKnownUserJid(values.id ?? "");
  const lidJid = normalizeKnownUserJid(values.lid ?? "");
  return (
    (extractLidDigits(idJid) ? idJid : null) ??
    (extractLidDigits(lidJid) ? lidJid : null) ??
    idJid ??
    lidJid ??
    normalizeKnownUserJid(values.phoneNumber ?? "") ??
    normalizeKnownUserJid(values.e164 ?? "")
  );
}

function buildMentionTargetMaps(participants: readonly WhatsAppOutboundMentionParticipant[]): {
  byPhone: Map<string, MentionTarget>;
  byLid: Map<string, MentionTarget>;
} {
  const byPhone = new Map<string, MentionTarget>();
  const byLid = new Map<string, MentionTarget>();
  for (const participant of participants) {
    const values = typeof participant === "string" ? { id: participant } : participant;
    const mentionJid = chooseMentionJid(values);
    if (!mentionJid) {
      continue;
    }
    const lidDigits = extractLidDigits(mentionJid);
    const target = {
      mentionJid,
      ...(lidDigits ? { replacementText: `@${lidDigits}` } : {}),
    };
    for (const value of [values.id, values.phoneNumber, values.e164]) {
      const digits = extractPhoneDigits(value);
      if (digits && !byPhone.has(digits)) {
        byPhone.set(digits, target);
      }
    }
    for (const value of [values.id, values.lid]) {
      const digits = extractLidDigits(value);
      if (digits && !byLid.has(digits)) {
        byLid.set(digits, target);
      }
    }
  }
  return { byPhone, byLid };
}

function shouldSkipMentionAt(
  text: string,
  index: number,
  end: number,
  codeRanges: CodeRegion[],
): boolean {
  if (isInsideCode(index, codeRanges)) {
    return true;
  }
  const previous = index > 0 ? text[index - 1] : "";
  const next = text[end] ?? "";
  return Boolean((previous && /[\w@]/.test(previous)) || (next && /[\w@]/.test(next)));
}

export function resolveWhatsAppOutboundMentions(params: {
  chatJid: string;
  text: string;
  participants?: readonly WhatsAppOutboundMentionParticipant[];
}): WhatsAppOutboundMentionResolution {
  if (
    !params.chatJid.endsWith("@g.us") ||
    !mayContainWhatsAppOutboundMention(params.text) ||
    !params.participants?.length
  ) {
    return { text: params.text, mentionedJids: [] };
  }

  const { byPhone, byLid } = buildMentionTargetMaps(params.participants);
  if (byPhone.size === 0 && byLid.size === 0) {
    return { text: params.text, mentionedJids: [] };
  }

  const codeRanges = collectCodeRanges(params.text);
  const mentionedJids = new Set<string>();
  const text = params.text.replace(
    OUTBOUND_MENTION_RE,
    (token, rawDigits: string, start: number) => {
      if (shouldSkipMentionAt(params.text, start, start + token.length, codeRanges)) {
        return token;
      }
      const digits = rawDigits.replace(/\D/g, "");
      const target = token.startsWith("@+")
        ? (byPhone.get(digits) ?? byLid.get(digits))
        : (byLid.get(digits) ?? byPhone.get(digits));
      if (!target) {
        return token;
      }
      mentionedJids.add(target.mentionJid);
      return target.replacementText ?? token;
    },
  );
  return { text, mentionedJids: [...mentionedJids] };
}

export function addWhatsAppOutboundMentionsToContent(
  content: AnyMessageContent,
  mentionedJids: readonly string[],
): AnyMessageContent {
  return mentionedJids.length > 0
    ? ({ ...content, mentions: [...mentionedJids] } as AnyMessageContent)
    : content;
}
