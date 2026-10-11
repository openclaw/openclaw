// withTelegramPlainFallback owns formatted-to-plain recovery for durable sends,
// final replies, and draft previews. A second orchestrator reintroduces silent drift.
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import type { TelegramRichBlocksDegradationReason } from "./rich-block-model.js";

// Any RICH_MESSAGE_*_INVALID rejection (entities, media, depth) degrades to
// plain text; media content validity (e.g. AUDIO_INVALID for a non-decodable
// file, live-verified) is only knowable server-side.
const RICH_ENTITY_INVALID_RE = /RICH_MESSAGE_[A-Z_]+_INVALID/i;
const RICH_CONTENT_REQUIRED_RE = /RICH_MESSAGE_CONTENT_REQUIRED|rich message must be non-empty/i;
const EMPTY_TEXT_RE = /message text is empty|text must be non-empty/i;
// Structural-limit rejections, live-verified against Bot API 10.2 (2026-07-15):
// >500 recursively counted blocks, >16 depth, oversized text, >50 media, >20 table cols.
const RICH_STRUCTURE_INVALID_RE =
  /RICH_MESSAGE_(?:BLOCKS_TOO_MANY|DEPTH_INVALID|TEXT_TOO_LONG|MEDIA_TOO_MANY|TABLE_COLS_TOO_MANY)/i;
const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity|can't parse InputRichBlock/i;

type TelegramPlainFallbackTrigger =
  | "rich-entity-invalid"
  | "rich-structure-invalid"
  | "html-parse"
  | "rich-content-required"
  | "empty-content";
const FALLBACK_TRIGGERS: Record<"rich" | "html", Array<[RegExp, TelegramPlainFallbackTrigger]>> = {
  rich: [
    [RICH_ENTITY_INVALID_RE, "rich-entity-invalid"],
    [RICH_CONTENT_REQUIRED_RE, "rich-content-required"],
    [RICH_STRUCTURE_INVALID_RE, "rich-structure-invalid"],
    [PARSE_ERR_RE, "html-parse"],
  ],
  html: [
    [PARSE_ERR_RE, "html-parse"],
    [EMPTY_TEXT_RE, "empty-content"],
    [RICH_CONTENT_REQUIRED_RE, "empty-content"],
  ],
};

type TelegramPlainFallbackPlan = {
  plainText: string;
  chunks: string[];
};

export function isTelegramHtmlParseError(err: unknown): boolean {
  return PARSE_ERR_RE.test(formatErrorMessage(err));
}

export function isTelegramEmptyContentError(err: unknown): boolean {
  const message = formatErrorMessage(err);
  return EMPTY_TEXT_RE.test(message) || RICH_CONTENT_REQUIRED_RE.test(message);
}

export function splitTelegramPlainTextChunks(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return chunkTextForOutbound(text, normalizedLimit, { preserveWhitespace: true });
}

export async function withTelegramPlainFallback<T>(params: {
  kind: "rich" | "html";
  context: string;
  plainText: string;
  warn: (message: string) => void;
  limit?: number;
  sendFormatted: () => Promise<T>;
  sendPlain: (plan: TelegramPlainFallbackPlan, label: string) => Promise<T>;
}): Promise<T> {
  try {
    return await params.sendFormatted();
  } catch (err) {
    const message = formatErrorMessage(err);
    const trigger = FALLBACK_TRIGGERS[params.kind].find(([pattern]) => pattern.test(message))?.[1];
    if (!trigger || !params.plainText.trim()) {
      throw err;
    }
    params.warn(`telegram ${params.context} degrade=plain-fallback:${trigger}: ${message}`);
    const limit = params.limit ?? 4000;
    const chunks = splitTelegramPlainTextChunks(params.plainText, limit);
    return await params.sendPlain(
      {
        plainText: params.plainText,
        chunks,
      },
      `${params.context}-plain`,
    );
  }
}

export function warnTelegramRichBlocksDegradations(params: {
  context: string;
  reasons: readonly TelegramRichBlocksDegradationReason[];
  warn: (message: string) => void;
}): void {
  for (const reason of new Set(params.reasons)) {
    params.warn(`telegram ${params.context} rich-degrade=${reason}`);
  }
}
