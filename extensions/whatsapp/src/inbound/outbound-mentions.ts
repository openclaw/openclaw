// Whatsapp plugin module implements outbound mentions behavior.
import type { AnyMessageContent } from "baileys";
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
const INLINE_CODE_RE = /`[^`\n]+`/g;
const OUTBOUND_MENTION_RE = /@(\+?\d+)/g;

type TextRange = {
  start: number;
  end: number;
};

type MentionTarget = {
  mentionJid: string;
  replacementText?: string;
};

function isWhatsAppGroupJid(jid: string): boolean {
  return classifyWhatsAppJid(jid).kind === "group";
}

export function mayContainWhatsAppOutboundMention(text: string): boolean {
  return /@\+?\d/.test(text);
}

function collectCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(CODE_FENCE_RE)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(INLINE_CODE_RE)) {
    const start = match.index;
    if (ranges.some((range) => start >= range.start && start < range.end)) {
      continue;
    }
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges.toSorted((a, b) => a.start - b.start);
}

function isInRange(index: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
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

function isLidJid(jid: string): boolean {
  return classifyWhatsAppDirectJid(jid)?.kind === "lid";
}

function lidReplacementText(jid: string): string | undefined {
  const classified = classifyWhatsAppDirectJid(jid);
  return classified?.kind === "lid" ? `@${classified.user}` : undefined;
}

function participantValues(participant: WhatsAppOutboundMentionParticipant): {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  e164?: string | null;
} {
  return typeof participant === "string" ? { id: participant } : participant;
}

function chooseMentionJid(participant: WhatsAppOutboundMentionParticipant): string | null {
  const values = participantValues(participant);
  const idJid = normalizeKnownUserJid(values.id ?? "");
  const lidJid = normalizeKnownUserJid(values.lid ?? "");
  return (
    (idJid && isLidJid(idJid) ? idJid : null) ??
    (lidJid && isLidJid(lidJid) ? lidJid : null) ??
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
    const mentionJid = chooseMentionJid(participant);
    if (!mentionJid) {
      continue;
    }
    const target = {
      mentionJid,
      ...(isLidJid(mentionJid) ? { replacementText: lidReplacementText(mentionJid) } : {}),
    };
    const values = participantValues(participant);
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
  codeRanges: readonly TextRange[],
): boolean {
  if (isInRange(index, codeRanges)) {
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
    !isWhatsAppGroupJid(params.chatJid) ||
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
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const mentionedJids: string[] = [];
  const seenMentionJids = new Set<string>();

  for (const match of params.text.matchAll(OUTBOUND_MENTION_RE)) {
    const start = match.index;
    const token = match[0];
    if (shouldSkipMentionAt(params.text, start, start + token.length, codeRanges)) {
      continue;
    }
    const rawDigits = match[1];
    if (!rawDigits) {
      continue;
    }
    const digits = rawDigits.replace(/\D/g, "");
    const target = token.startsWith("@+")
      ? (byPhone.get(digits) ?? byLid.get(digits))
      : (byLid.get(digits) ?? byPhone.get(digits));
    if (!target) {
      continue;
    }
    if (!seenMentionJids.has(target.mentionJid)) {
      seenMentionJids.add(target.mentionJid);
      mentionedJids.push(target.mentionJid);
    }
    if (target.replacementText && target.replacementText !== token) {
      replacements.push({
        start,
        end: start + token.length,
        text: target.replacementText,
      });
    }
  }

  if (replacements.length === 0) {
    return { text: params.text, mentionedJids };
  }

  let text = "";
  let cursor = 0;
  for (const replacement of replacements) {
    text += params.text.slice(cursor, replacement.start);
    text += replacement.text;
    cursor = replacement.end;
  }
  text += params.text.slice(cursor);
  return { text, mentionedJids };
}

export function addWhatsAppOutboundMentionsToContent(
  content: AnyMessageContent,
  mentionedJids: readonly string[],
): AnyMessageContent {
  return mentionedJids.length > 0
    ? ({ ...content, mentions: [...mentionedJids] } as AnyMessageContent)
    : content;
}
