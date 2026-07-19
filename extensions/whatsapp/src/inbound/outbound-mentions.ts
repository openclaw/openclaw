import type { AnyMessageContent } from "baileys";
import { isInsideCode, type CodeRegion } from "openclaw/plugin-sdk/text-chunking";
import { stripWhatsAppTargetPrefixes } from "../whatsapp-jid-syntax.js";
import {
  classifyWhatsAppDirectJid,
  classifyWhatsAppJid,
  encodeWhatsAppJid,
} from "../whatsapp-jid.js";

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
  const trimmed = stripWhatsAppTargetPrefixes(value);
  const classified = classifyWhatsAppJid(trimmed);
  if (classified.kind === "pn" || classified.kind === "lid") {
    return classified.jid;
  }
  const digits = trimmed.startsWith("+")
    ? trimmed.replace(/\D/g, "")
    : /^\d+$/.test(trimmed)
      ? trimmed
      : "";
  return digits ? encodeWhatsAppJid(digits, "s.whatsapp.net") : null;
}

function extractPhoneDigits(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = stripWhatsAppTargetPrefixes(value);
  if (trimmed.startsWith("+") || /^\d+$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    return digits || null;
  }
  const classified = classifyWhatsAppDirectJid(normalizeKnownUserJid(trimmed));
  return classified?.kind === "pn" ? classified.user : null;
}

function extractLidDigits(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const classified = classifyWhatsAppDirectJid(normalizeKnownUserJid(value));
  return classified?.kind === "lid" ? classified.user : null;
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
    classifyWhatsAppJid(params.chatJid).kind !== "group" ||
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
  mentionedJids: string[],
): AnyMessageContent {
  return mentionedJids.length > 0
    ? ({ ...content, mentions: mentionedJids } as AnyMessageContent)
    : content;
}
