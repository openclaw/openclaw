import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { TelegramTextEntity } from "./body-helpers.js";

const TELEGRAM_NATIVE_QUOTE_MAX_LENGTH = 1024;

export type TelegramNativeQuoteCandidate = {
  text: string;
  position?: number;
  entities?: unknown[];
};

export type TelegramNativeQuoteCandidateByMessageId = Record<string, TelegramNativeQuoteCandidate>;

function sliceTelegramEntitiesForQuote(
  entities: readonly TelegramTextEntity[] | undefined,
  quoteLength: number,
): TelegramTextEntity[] | undefined {
  if (!entities?.length || quoteLength <= 0) {
    return undefined;
  }
  const sliced: TelegramTextEntity[] = [];
  for (const entity of entities) {
    const offset = Number.isFinite(entity.offset) ? Math.trunc(entity.offset) : 0;
    const length = Number.isFinite(entity.length) ? Math.trunc(entity.length) : 0;
    const start = Math.max(0, offset);
    const end = Math.min(quoteLength, offset + length);
    if (end <= start) {
      continue;
    }
    sliced.push({
      ...entity,
      offset: start,
      length: end - start,
    });
  }
  return sliced.length > 0 ? sliced : undefined;
}

export function buildTelegramNativeQuoteCandidate(params: {
  text?: string;
  entities?: readonly TelegramTextEntity[];
  maxLength?: number;
}): TelegramNativeQuoteCandidate | undefined {
  const source = params.text;
  if (!source?.trim()) {
    return undefined;
  }
  const maxLength = params.maxLength ?? TELEGRAM_NATIVE_QUOTE_MAX_LENGTH;
  const text = truncateUtf16Safe(source, maxLength);
  if (!text.trim()) {
    return undefined;
  }
  const entities = sliceTelegramEntitiesForQuote(params.entities, text.length);
  return { text, position: 0, ...(entities ? { entities } : {}) };
}

export function addTelegramNativeQuoteCandidate(
  target: TelegramNativeQuoteCandidateByMessageId,
  messageId: string | number | undefined,
  candidate: TelegramNativeQuoteCandidate | undefined,
): void {
  if (messageId == null || !candidate) {
    return;
  }
  const key = String(messageId).trim();
  if (!key || target[key]) {
    return;
  }
  target[key] = candidate;
}

type TelegramReplyQuoteForSend = {
  messageId?: number;
  text?: string;
  position?: number;
  entities?: unknown[];
};

export function resolveReplyQuoteForSend(params: {
  replyToId?: number;
  replyQuoteByMessageId?: TelegramNativeQuoteCandidateByMessageId;
  replyQuoteMessageId?: number;
  replyQuoteText?: string;
  replyQuotePosition?: number;
  replyQuoteEntities?: unknown[];
}): TelegramReplyQuoteForSend {
  if (params.replyToId != null) {
    const mapped = params.replyQuoteByMessageId?.[String(params.replyToId)];
    if (mapped?.text) {
      return {
        messageId: params.replyToId,
        text: mapped.text,
        ...(typeof mapped.position === "number" ? { position: mapped.position } : {}),
        ...(mapped.entities ? { entities: mapped.entities } : {}),
      };
    }
  }
  return {
    ...(params.replyQuoteMessageId != null ? { messageId: params.replyQuoteMessageId } : {}),
    ...(params.replyQuoteText != null ? { text: params.replyQuoteText } : {}),
    ...(params.replyQuotePosition != null ? { position: params.replyQuotePosition } : {}),
    ...(params.replyQuoteEntities != null ? { entities: params.replyQuoteEntities } : {}),
  };
}
