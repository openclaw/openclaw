import { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
import type { SignalMention } from "./event-handler.types.js";

const OBJECT_REPLACEMENT = "\uFFFC";

function isValidMention(mention: SignalMention | null | undefined): mention is SignalMention {
  if (!mention) {
    return false;
  }
  if (!(mention.uuid || mention.number)) {
    return false;
  }
  if (typeof mention.start !== "number" || Number.isNaN(mention.start)) {
    return false;
  }
  if (typeof mention.length !== "number" || Number.isNaN(mention.length)) {
    return false;
  }
  return mention.length > 0;
}

function clampBounds(start: number, length: number, textLength: number) {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeLength = Math.max(0, Math.trunc(length));
  const safeEnd = Math.min(textLength, safeStart + safeLength);
  return { start: safeStart, end: safeEnd };
}

export function doesSignalMentionTargetBot(
  mentions: SignalMention[] | null | undefined,
  botAccount: { phone?: string | null; uuid?: string | null },
): boolean {
  if (!mentions?.length) {
    return false;
  }
  const botUuid = botAccount.uuid?.trim() || undefined;
  const botPhone = botAccount.phone ? normalizeE164(botAccount.phone) : undefined;
  if (!botUuid && !botPhone) {
    return false;
  }
  for (const mention of mentions) {
    if (!mention) {
      continue;
    }
    const mentionUuid = mention.uuid?.trim();
    if (botUuid && mentionUuid && mentionUuid === botUuid) {
      return true;
    }
    const mentionNumber = mention.number?.trim();
    if (botPhone && mentionNumber && normalizeE164(mentionNumber) === botPhone) {
      return true;
    }
  }
  return false;
}

export function renderSignalMentions(message: string, mentions?: SignalMention[] | null) {
  if (!message || !mentions?.length) {
    return message;
  }

  let normalized = message;
  const candidates = mentions.filter(isValidMention).toSorted((a, b) => b.start! - a.start!);

  for (const mention of candidates) {
    const identifier = mention.uuid ?? mention.number;
    if (!identifier) {
      continue;
    }

    const { start, end } = clampBounds(mention.start!, mention.length!, normalized.length);
    if (start >= end) {
      continue;
    }
    const slice = normalized.slice(start, end);

    if (!slice.includes(OBJECT_REPLACEMENT)) {
      continue;
    }

    normalized = normalized.slice(0, start) + `@${identifier}` + normalized.slice(end);
  }

  return normalized;
}
