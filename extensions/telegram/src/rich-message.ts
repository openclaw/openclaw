// Telegram rich message helpers isolate Bot API 10.1 calls until grammY types catch up.
import type { Bot } from "grammy";
import type {
  ForceReply,
  InlineKeyboardMarkup,
  Message,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
  ReplyParameters,
} from "grammy/types";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  escapeTelegramHtml,
  limitTelegramRichHtmlNesting,
  markdownToTelegramRichHtml,
  sanitizeTelegramRichHtml,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
} from "./format.js";

type TelegramRichMessageReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove
  | ForceReply;

export const TELEGRAM_RICH_TEXT_LIMIT = 32_768;
export const TELEGRAM_RICH_BLOCK_LIMIT = 500;
export const TELEGRAM_RICH_MEDIA_LIMIT = 50;
export const TELEGRAM_RICH_NESTING_LIMIT = 16;

export type TelegramInputRichMessage =
  | {
      markdown: string;
      html?: never;
      is_rtl?: boolean;
      skip_entity_detection?: boolean;
    }
  | {
      html: string;
      markdown?: never;
      is_rtl?: boolean;
      skip_entity_detection?: boolean;
    };

type TelegramRichMessageOptions = {
  skipEntityDetection?: boolean;
  tableMode?: MarkdownTableMode;
};

export type TelegramRichTextMode = "markdown" | "html";

export type TelegramRichTextChunk = {
  text: string;
  textMode: "html";
  plainText: string;
};

export type TelegramSendRichMessageParams = {
  business_connection_id?: string;
  chat_id: number | string;
  message_thread_id?: number;
  direct_messages_topic_id?: number;
  rich_message: TelegramInputRichMessage;
  disable_notification?: boolean;
  protect_content?: boolean;
  allow_paid_broadcast?: boolean;
  message_effect_id?: string;
  suggested_post_parameters?: unknown;
  reply_parameters?: ReplyParameters;
  reply_markup?: TelegramRichMessageReplyMarkup;
};

export type TelegramRichMessageContextParams = Pick<
  TelegramSendRichMessageParams,
  "disable_notification" | "message_thread_id" | "reply_parameters"
>;

export type TelegramEditRichMessageTextParams = {
  business_connection_id?: string;
  chat_id?: number | string;
  message_id?: number;
  inline_message_id?: string;
  rich_message: TelegramInputRichMessage;
  reply_markup?: InlineKeyboardMarkup;
};

type TelegramRichRawApi = {
  sendRichMessage: (params: TelegramSendRichMessageParams) => Promise<Message>;
  editMessageText: (params: TelegramEditRichMessageTextParams) => Promise<Message | true>;
};

type TelegramApiWithRichRaw = Bot["api"] & {
  raw?: TelegramRichRawApi;
};

export function getTelegramRichRawApi(api: Bot["api"]): TelegramRichRawApi {
  const raw = (api as TelegramApiWithRichRaw).raw;
  if (raw) {
    return raw;
  }
  throw new Error("Telegram rich messages require grammY api.raw");
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function isReplyParameters(value: unknown): value is ReplyParameters {
  if (!value || typeof value !== "object") {
    return false;
  }
  return finiteInteger((value as { message_id?: unknown }).message_id) !== undefined;
}

export function toTelegramRichMessageContextParams(
  params: Record<string, unknown> | undefined,
): TelegramRichMessageContextParams {
  const richParams: TelegramRichMessageContextParams = {};
  const messageThreadId = finiteInteger(params?.message_thread_id);
  if (messageThreadId !== undefined) {
    richParams.message_thread_id = messageThreadId;
  }
  if (params?.disable_notification === true) {
    richParams.disable_notification = true;
  }
  if (isReplyParameters(params?.reply_parameters)) {
    richParams.reply_parameters = params.reply_parameters;
    return richParams;
  }
  const replyToMessageId = finiteInteger(params?.reply_to_message_id);
  if (replyToMessageId !== undefined) {
    richParams.reply_parameters = {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    };
  }
  return richParams;
}

export function removeTelegramRichNativeQuoteParam(
  params: Record<string, unknown> | undefined,
): TelegramRichMessageContextParams {
  const richParams = toTelegramRichMessageContextParams(params);
  if (!richParams.reply_parameters) {
    return richParams;
  }
  const {
    quote: _quote,
    quote_entities: _quoteEntities,
    quote_parse_mode: _quoteParseMode,
    quote_position: _quotePosition,
    ...replyParameters
  } = richParams.reply_parameters;
  return {
    ...richParams,
    reply_parameters: replyParameters,
  };
}

export function buildTelegramRichMarkdown(
  markdown: string,
  options?: TelegramRichMessageOptions,
): TelegramInputRichMessage {
  return buildTelegramRichHtml(markdownToTelegramRichHtml(markdown, options), options);
}

export function buildTelegramRichHtml(
  html: string,
  options?: TelegramRichMessageOptions,
): TelegramInputRichMessage {
  const safeHtml = prepareTelegramRichHtml(html);
  return options?.skipEntityDetection === true
    ? { html: safeHtml, skip_entity_detection: true }
    : { html: safeHtml };
}

export function buildTelegramRichMessage(
  text: string,
  textMode: TelegramRichTextMode,
  options?: TelegramRichMessageOptions,
): TelegramInputRichMessage {
  return textMode === "html"
    ? buildTelegramRichHtml(text, options)
    : buildTelegramRichMarkdown(text, options);
}

function prepareTelegramRichHtml(html: string): string {
  return limitTelegramRichHtmlNesting(
    preserveTelegramRichHtmlTextLineBreaks(sanitizeTelegramRichHtml(html)),
    TELEGRAM_RICH_NESTING_LIMIT,
  );
}

function preserveTelegramRichHtmlTextLineBreaks(html: string): string {
  if (!html.includes("\n")) {
    return html;
  }

  let output = "";
  let lastIndex = 0;
  let protectedDepth = 0;
  const tagPattern = /<\/?([a-zA-Z][\w:-]*)\b[^>]*>/g;
  let previousTag: TelegramRichHtmlLineBreakTag | undefined;

  const appendText = (
    text: string,
    previous: TelegramRichHtmlLineBreakTag | undefined,
    next: TelegramRichHtmlLineBreakTag | undefined,
  ): void => {
    if (!text) {
      return;
    }
    if (protectedDepth > 0 || !shouldMaterializeTelegramRichHtmlTextLineBreaks(text, previous, next)) {
      output += text;
      return;
    }
    output += materializeTelegramRichHtmlTextLineBreaks(text, previous, next);
  };

  for (const match of html.matchAll(tagPattern)) {
    const rawTag = match[0] ?? "";
    const tagName = (match[1] ?? "").toLowerCase();
    const isClosing = rawTag.startsWith("</");
    const isSelfClosing = /\/\s*>$/.test(rawTag) || tagName === "br";
    const currentTag = { tagName, isClosing, isSelfClosing };

    appendText(html.slice(lastIndex, match.index), previousTag, currentTag);

    if (TELEGRAM_RICH_LINE_BREAK_PROTECTED_TAGS.has(tagName) && isClosing) {
      protectedDepth = Math.max(0, protectedDepth - 1);
    }

    output += rawTag;

    if (TELEGRAM_RICH_LINE_BREAK_PROTECTED_TAGS.has(tagName) && !isClosing && !isSelfClosing) {
      protectedDepth += 1;
    }

    previousTag = currentTag;
    lastIndex = (match.index ?? 0) + rawTag.length;
  }

  appendText(html.slice(lastIndex), previousTag, undefined);
  return output;
}

type TelegramRichHtmlLineBreakTag = {
  tagName: string;
  isClosing: boolean;
  isSelfClosing: boolean;
};

const TELEGRAM_RICH_LINE_BREAK_PROTECTED_TAGS = new Set(["code", "pre", "tg-math", "tg-math-block"]);
const TELEGRAM_RICH_LINE_BREAK_BLOCK_TAGS = new Set([
  "aside",
  "audio",
  "blockquote",
  "details",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "caption",
  "col",
  "colgroup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tg-collage",
  "tg-map",
  "tg-math-block",
  "tg-slideshow",
  "tr",
  "ul",
  "video",
]);

function shouldMaterializeTelegramRichHtmlTextLineBreaks(
  text: string,
  previousTag: TelegramRichHtmlLineBreakTag | undefined,
  nextTag: TelegramRichHtmlLineBreakTag | undefined,
): boolean {
  if (!text.includes("\n")) {
    return false;
  }
  if (/[^\s]/u.test(text)) {
    return true;
  }
  return isTelegramRichInlineLineBreakBoundary(previousTag, nextTag);
}

function materializeTelegramRichHtmlTextLineBreaks(
  text: string,
  previousTag: TelegramRichHtmlLineBreakTag | undefined,
  nextTag: TelegramRichHtmlLineBreakTag | undefined,
): string {
  if (!/[^\s]/u.test(text)) {
    return text.replace(/\n/g, "<br>");
  }

  const firstContentIndex = text.search(/[^\s]/u);
  const lastContentIndex = lastNonWhitespaceIndex(text);
  const preserveLeadingStructuralBreaks = isOpeningTelegramRichStructuralTag(previousTag);
  const preserveTrailingStructuralBreaks = isClosingTelegramRichStructuralTag(nextTag);
  let output = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (
      char === "\n" &&
      !(preserveLeadingStructuralBreaks && index < firstContentIndex) &&
      !(preserveTrailingStructuralBreaks && index > lastContentIndex)
    ) {
      output += "<br>";
      continue;
    }
    output += char;
  }

  return output;
}

function lastNonWhitespaceIndex(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/[^\s]/u.test(text[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

function isOpeningTelegramRichStructuralTag(tag: TelegramRichHtmlLineBreakTag | undefined): boolean {
  return Boolean(
    tag &&
      !tag.isClosing &&
      !tag.isSelfClosing &&
      TELEGRAM_RICH_LINE_BREAK_BLOCK_TAGS.has(tag.tagName),
  );
}

function isClosingTelegramRichStructuralTag(tag: TelegramRichHtmlLineBreakTag | undefined): boolean {
  return Boolean(tag?.isClosing && TELEGRAM_RICH_LINE_BREAK_BLOCK_TAGS.has(tag.tagName));
}

function isTelegramRichInlineLineBreakBoundary(
  previousTag: TelegramRichHtmlLineBreakTag | undefined,
  nextTag: TelegramRichHtmlLineBreakTag | undefined,
): boolean {
  if (!previousTag || !nextTag || !previousTag.isClosing || nextTag.isClosing) {
    return false;
  }
  return (
    !TELEGRAM_RICH_LINE_BREAK_BLOCK_TAGS.has(previousTag.tagName) &&
    !TELEGRAM_RICH_LINE_BREAK_BLOCK_TAGS.has(nextTag.tagName)
  );
}

const TELEGRAM_RICH_HTML_CHUNK_LIMITS = {
  blockLimit: TELEGRAM_RICH_BLOCK_LIMIT,
  mediaLimit: TELEGRAM_RICH_MEDIA_LIMIT,
} as const;

function splitPreparedTelegramRichHtml(params: {
  html: string;
  sourceFallback: string;
  textLimit: number;
}): string[] {
  try {
    const chunks = splitTelegramHtmlChunks(
      params.html,
      params.textLimit,
      TELEGRAM_RICH_HTML_CHUNK_LIMITS,
    );
    if (chunks.length > 0) {
      return chunks;
    }
  } catch {
    // Fall through to readable source text when rich planning cannot preserve the payload.
  }
  return splitTelegramHtmlChunks(escapeTelegramHtml(params.sourceFallback), params.textLimit);
}

export function isTelegramRichMessageWithinStructuralLimits(
  message: TelegramInputRichMessage,
): boolean {
  if (message.markdown !== undefined) {
    if (splitTelegramRichMarkdownBlocks(message.markdown, TELEGRAM_RICH_BLOCK_LIMIT).length > 1) {
      return false;
    }
    return (
      splitTelegramHtmlChunks(
        prepareTelegramRichHtml(markdownToTelegramRichHtml(message.markdown)),
        TELEGRAM_RICH_TEXT_LIMIT,
        TELEGRAM_RICH_HTML_CHUNK_LIMITS,
      ).length <= 1
    );
  }
  return (
    splitTelegramHtmlChunks(
      prepareTelegramRichHtml(message.html),
      TELEGRAM_RICH_TEXT_LIMIT,
      TELEGRAM_RICH_HTML_CHUNK_LIMITS,
    ).length <= 1
  );
}

type RichMarkdownFenceSpan = {
  start: number;
  end: number;
};

function parseRichMarkdownFenceSpans(markdown: string): RichMarkdownFenceSpan[] {
  const spans: RichMarkdownFenceSpan[] = [];
  let open:
    | {
        start: number;
        markerChar: string;
        markerLength: number;
      }
    | undefined;
  let offset = 0;
  while (offset <= markdown.length) {
    const nextNewline = markdown.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? markdown.length : nextNewline;
    const line = markdown.slice(offset, lineEnd);
    const match = line.match(/^( {0,3})(`{3,}|~{3,})/);
    if (match) {
      const marker = match[2];
      const markerChar = marker[0];
      if (!open) {
        open = { start: offset, markerChar, markerLength: marker.length };
      } else if (open.markerChar === markerChar && marker.length >= open.markerLength) {
        spans.push({ start: open.start, end: lineEnd });
        open = undefined;
      }
    }
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }
  if (open) {
    spans.push({ start: open.start, end: markdown.length });
  }
  return spans;
}

function isSafeRichMarkdownBlockBreak(spans: readonly RichMarkdownFenceSpan[], index: number) {
  return !spans.some((span) => index > span.start && index < span.end);
}

type RichMarkdownBlockBreak = {
  start: number;
  end: number;
  separator: string;
};

function findTelegramRichMarkdownBlockBreaks(markdown: string): RichMarkdownBlockBreak[] {
  const breaks: RichMarkdownBlockBreak[] = [];
  for (const match of markdown.matchAll(/\n[\t ]*\n+/g)) {
    const start = match.index ?? 0;
    breaks.push({
      start,
      end: start + match[0].length,
      separator: match[0],
    });
  }
  for (const match of markdown.matchAll(/^ {0,3}#{1,6}\s+\S.*$/gm)) {
    const headingStart = match.index ?? 0;
    if (headingStart > 0 && markdown[headingStart - 1] === "\n") {
      breaks.push({
        start: headingStart - 1,
        end: headingStart,
        separator: "\n",
      });
    }
  }
  return breaks.toSorted((left, right) => left.start - right.start || right.end - left.end);
}

function splitTelegramRichMarkdownBlocks(markdown: string, blockLimit: number): string[] {
  if (!markdown.trim()) {
    return markdown ? [markdown] : [];
  }

  const blocks: Array<{ text: string; separatorBefore?: string }> = [];
  const fenceSpans = parseRichMarkdownFenceSpans(markdown);
  let lastIndex = 0;
  let separatorBefore: string | undefined;
  for (const blockBreak of findTelegramRichMarkdownBlockBreaks(markdown)) {
    if (blockBreak.start < lastIndex) {
      continue;
    }
    if (!isSafeRichMarkdownBlockBreak(fenceSpans, blockBreak.start)) {
      continue;
    }
    const text = markdown.slice(lastIndex, blockBreak.start);
    if (text.trim()) {
      blocks.push({ text, ...(separatorBefore ? { separatorBefore } : {}) });
    }
    separatorBefore = blockBreak.separator;
    lastIndex = blockBreak.end;
  }
  const tail = markdown.slice(lastIndex);
  if (tail.trim()) {
    blocks.push({ text: tail, ...(separatorBefore ? { separatorBefore } : {}) });
  }

  if (blocks.length <= blockLimit) {
    return [markdown];
  }

  const chunks: string[] = [];
  let chunk = "";
  let chunkBlocks = 0;
  for (const block of blocks) {
    if (chunkBlocks >= blockLimit) {
      chunks.push(chunk);
      chunk = "";
      chunkBlocks = 0;
    }
    const separator = chunk ? (block.separatorBefore ?? "\n\n") : "";
    chunk += `${separator}${block.text}`;
    chunkBlocks += 1;
  }
  if (chunk) {
    chunks.push(chunk);
  }
  return chunks;
}

function splitTelegramRichMarkdownTextChunks(
  markdown: string,
  textLimit: number,
  chunkMode: ChunkMode,
): string[] {
  const chunks: string[] = [];
  const queue = chunkMarkdownTextWithMode(markdown, textLimit, chunkMode);
  for (let index = 0; index < queue.length; index += 1) {
    const chunk = queue[index] ?? "";
    if (chunk.length <= textLimit) {
      chunks.push(chunk);
      continue;
    }
    const reducedLimit = Math.max(1, Math.min(chunk.length - 1, textLimit - 16));
    const nextChunks = chunkMarkdownTextWithMode(chunk, reducedLimit, chunkMode);
    if (nextChunks.length <= 1) {
      chunks.push(chunk);
      continue;
    }
    queue.splice(index, 1, ...nextChunks);
    index -= 1;
  }
  return chunks;
}

export function splitTelegramRichMarkdownChunks(
  markdown: string,
  textLimit: number,
  chunkMode: ChunkMode,
): string[] {
  if (markdown.length <= textLimit) {
    return splitTelegramRichMarkdownBlocks(markdown, TELEGRAM_RICH_BLOCK_LIMIT);
  }
  return splitTelegramRichMarkdownTextChunks(markdown, textLimit, chunkMode).flatMap((chunk) =>
    splitTelegramRichMarkdownBlocks(chunk, TELEGRAM_RICH_BLOCK_LIMIT),
  );
}

export function splitTelegramRichMessageTextChunks(params: {
  text: string;
  textLimit: number;
  textMode: TelegramRichTextMode;
  chunkMode: ChunkMode;
  tableMode?: MarkdownTableMode;
  skipEntityDetection?: boolean;
}): TelegramRichTextChunk[] {
  const renderMarkdownChunk = (chunk: string) =>
    prepareTelegramRichHtml(
      markdownToTelegramRichHtml(chunk, {
        tableMode: params.tableMode,
        skipEntityDetection: params.skipEntityDetection,
      }),
    );
  const htmlChunks =
    params.textMode === "html"
      ? splitPreparedTelegramRichHtml({
          html: prepareTelegramRichHtml(params.text),
          sourceFallback: params.text,
          textLimit: params.textLimit,
        })
      : splitTelegramRichMarkdownChunks(params.text, params.textLimit, params.chunkMode).flatMap(
          (chunk) =>
            splitPreparedTelegramRichHtml({
              html: renderMarkdownChunk(chunk),
              sourceFallback: chunk,
              textLimit: params.textLimit,
            }),
        );
  return htmlChunks.map((chunk) => ({
    text: chunk,
    textMode: "html",
    plainText: telegramHtmlToPlainTextFallback(chunk),
  }));
}
