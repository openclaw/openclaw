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
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { splitTelegramHtmlChunks } from "./format.js";

type TelegramRichMessageReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove
  | ForceReply;

export const TELEGRAM_RICH_TEXT_LIMIT = 32_768;
export const TELEGRAM_RICH_BLOCK_LIMIT = 500;
export const TELEGRAM_RICH_TABLE_COLUMN_LIMIT = 20;

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
};

export type TelegramRichTextMode = "markdown" | "html";

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
  const normalizedMarkdown = normalizeTelegramRichMarkdown(sanitizeTelegramRichMarkdown(markdown));
  return options?.skipEntityDetection === true
    ? { markdown: normalizedMarkdown, skip_entity_detection: true }
    : { markdown: normalizedMarkdown };
}

export function buildTelegramRichHtml(
  html: string,
  options?: TelegramRichMessageOptions,
): TelegramInputRichMessage {
  const safeHtml = escapeTelegramRichHtmlMediaTags(html);
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

type RichMarkdownFenceSpan = {
  start: number;
  end: number;
};

function escapeTelegramRichHtmlTag(tag: string): string {
  return tag
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeTelegramRichHtmlMediaTags(html: string): string {
  return html.replace(
    /<\/?(?:img|picture|source|video|audio|track|iframe|embed|object)\b[^<>]*>/gi,
    (tag) => escapeTelegramRichHtmlTag(tag),
  );
}

function sanitizeTelegramRichMarkdown(markdown: string): string {
  return escapeTelegramRichHtmlMediaTags(markdown)
    .replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, "[$1]($2)")
    .replace(/!\[([^\]\n]*)\]\[([^\]\n]+)\]/g, "[$1][$2]");
}

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

function isRichMarkdownFenceMarker(line: string): boolean {
  return /^( {0,3})(`{3,}|~{3,})/.test(line);
}

function isRichMarkdownBlockLine(line: string, isTableLine: boolean): boolean {
  const trimmed = line.trimStart();
  return (
    isTableLine ||
    isRichMarkdownFenceMarker(line) ||
    /^#{1,6}\s+\S/.test(trimmed) ||
    trimmed.startsWith(">") ||
    /^(?:[-+*]|\d+[.)])\s+\S/.test(trimmed) ||
    /^[-*_][\s-*_-]{2,}$/.test(trimmed)
  );
}

function splitMarkdownTableRow(row: string): string[] {
  const trimmed = row.trim();
  const body = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed;
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      cell += char;
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function isMarkdownTableSeparator(row: string): boolean {
  const cells = splitMarkdownTableRow(row);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function isMarkdownTableRow(row: string): boolean {
  return splitMarkdownTableRow(row).length > 1;
}

function markdownTableColumnCount(row: string): number {
  return splitMarkdownTableRow(row).length;
}

function findRichMarkdownTableLineIndexes(
  markdown: string,
  lines: readonly string[],
  fenceSpans: readonly RichMarkdownFenceSpan[],
): Set<number> {
  const tableLineIndexes = new Set<number>();
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1];
    if (
      nextLine !== undefined &&
      isSafeRichMarkdownBlockBreak(fenceSpans, offset) &&
      isMarkdownTableRow(line) &&
      isMarkdownTableSeparator(nextLine)
    ) {
      tableLineIndexes.add(index);
      tableLineIndexes.add(index + 1);
      offset += line.length + 1 + nextLine.length + 1;
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        tableLineIndexes.add(index);
        offset += (lines[index] ?? "").length + 1;
        index += 1;
      }
      index -= 1;
      continue;
    }
    offset += line.length + 1;
  }
  return tableLineIndexes;
}

function preserveTelegramRichMarkdownLineBreaks(markdown: string): string {
  if (!markdown.includes("\n")) {
    return markdown;
  }

  const fenceSpans = parseRichMarkdownFenceSpans(markdown);
  const lines = markdown.split("\n");
  const tableLineIndexes = findRichMarkdownTableLineIndexes(markdown, lines, fenceSpans);
  const out: string[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1];
    if (nextLine === undefined) {
      out.push(line);
      break;
    }

    const newlineIndex = offset + line.length;
    const shouldPreserveBreak =
      line.length > 0 &&
      nextLine.length > 0 &&
      !line.endsWith("  ") &&
      !line.endsWith("\\") &&
      !isRichMarkdownBlockLine(line, tableLineIndexes.has(index)) &&
      !isRichMarkdownBlockLine(nextLine, tableLineIndexes.has(index + 1)) &&
      isSafeRichMarkdownBlockBreak(fenceSpans, newlineIndex);
    out.push(`${line}${shouldPreserveBreak ? "  " : ""}\n`);
    offset = newlineIndex + 1;
  }
  return out.join("");
}

function normalizeTelegramRichMarkdownTables(markdown: string): string {
  if (!markdown.includes("|")) {
    return markdown;
  }

  const fenceSpans = parseRichMarkdownFenceSpans(markdown);
  const lines = markdown.split("\n");
  const out: string[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1];
    if (
      nextLine !== undefined &&
      isSafeRichMarkdownBlockBreak(fenceSpans, offset) &&
      isMarkdownTableRow(line) &&
      isMarkdownTableSeparator(nextLine) &&
      Math.max(markdownTableColumnCount(line), markdownTableColumnCount(nextLine)) >
        TELEGRAM_RICH_TABLE_COLUMN_LIMIT
    ) {
      const tableLines = [line, nextLine];
      let consumed = line.length + 1 + nextLine.length + 1;
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        const tableLine = lines[index] ?? "";
        tableLines.push(tableLine);
        consumed += tableLine.length + 1;
        index += 1;
      }
      index -= 1;
      out.push("```", ...tableLines, "```");
      offset += consumed;
      continue;
    }
    out.push(line);
    offset += line.length + 1;
  }
  return out.join("\n");
}

function normalizeTelegramRichMarkdown(markdown: string): string {
  return preserveTelegramRichMarkdownLineBreaks(normalizeTelegramRichMarkdownTables(markdown));
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

export function splitTelegramRichMarkdownChunks(
  markdown: string,
  textLimit: number,
  chunkMode: ChunkMode,
): string[] {
  const normalizedMarkdown = normalizeTelegramRichMarkdown(markdown);
  return chunkMarkdownTextWithMode(normalizedMarkdown, textLimit, chunkMode).flatMap((chunk) =>
    splitTelegramRichMarkdownBlocks(chunk, TELEGRAM_RICH_BLOCK_LIMIT),
  );
}

export function splitTelegramRichTextChunks(params: {
  text: string;
  textLimit: number;
  textMode: TelegramRichTextMode;
  chunkMode: ChunkMode;
}): string[] {
  return params.textMode === "html"
    ? splitTelegramHtmlChunks(params.text, params.textLimit)
    : splitTelegramRichMarkdownChunks(params.text, params.textLimit, params.chunkMode);
}
