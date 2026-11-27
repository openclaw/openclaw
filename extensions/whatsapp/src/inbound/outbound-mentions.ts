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

function collectItalicDelimiters(text: string, codeRanges: CodeRegion[]): Set<number> {
  const delimiters = new Set<number>();
  let open: number | undefined;
  const word = /[\p{L}\p{M}\p{N}\p{Pc}@]/u;
  // Inspect adjacent code points without consuming them. Only paired formatting can bound a mention.
  for (const match of text.matchAll(/\\.|(?<=(.?))_(?=(.?))|\n[ \t\r]*\n/gu)) {
    if (match[0].startsWith("\n")) {
      open = undefined;
      continue;
    }
    if (match[0] !== "_" || isInsideCode(match.index, codeRanges)) {
      continue;
    }
    const before = match[1] ?? "";
    const after = match[2] ?? "";
    if (open !== undefined && /\S/.test(before) && !word.test(after)) {
      delimiters.add(open);
      delimiters.add(match.index);
      open = undefined;
    } else if (!word.test(before) && /\S/.test(after)) {
      open = match.index;
    }
  }
  return delimiters;
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

  const byPhone = new Map<string, MentionTarget>();
  const byLid = new Map<string, MentionTarget>();
  for (const participant of params.participants) {
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
  if (byPhone.size === 0 && byLid.size === 0) {
    return { text: params.text, mentionedJids: [] };
  }

  const codeRanges = collectCodeRanges(params.text);
  const italicDelimiters = collectItalicDelimiters(params.text, codeRanges);
  const touchesWord = (index: number) =>
    /[\w@]/.test(params.text[index] ?? "") && !italicDelimiters.has(index);
  const mentionedJids = new Set<string>();
  const text = params.text.replace(
    OUTBOUND_MENTION_RE,
    (token, rawDigits: string, start: number) => {
      if (
        isInsideCode(start, codeRanges) ||
        touchesWord(start - 1) ||
        touchesWord(start + token.length)
      ) {
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
  mentionedJids: string[],
): AnyMessageContent {
  return mentionedJids.length > 0
    ? ({ ...content, mentions: mentionedJids } as AnyMessageContent)
    : content;
}
