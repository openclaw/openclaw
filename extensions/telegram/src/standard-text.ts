import { randomBytes } from "node:crypto";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  markdownToTelegramChunks,
  renderTelegramHtmlText,
  telegramHtmlToPlainTextFallback,
} from "./format.js";

const TELEGRAM_STANDARD_TEXT_LIMIT = 4096;
const TELEGRAM_FRAGMENT_ADMISSION_FLOOR = 4000;
export const TELEGRAM_STANDARD_FRAGMENT_MARKER = "\u2060";
const TELEGRAM_STANDARD_FRAGMENT_START = "\u200b";
const TELEGRAM_STANDARD_FRAGMENT_CONTINUATION = "\u200c";
const TELEGRAM_STANDARD_FRAGMENT_END = "\u200d";
const TELEGRAM_STANDARD_FRAGMENT_ABORT = "\u2061";
const TELEGRAM_STANDARD_FRAGMENT_ID_ZERO = "\u200b";
const TELEGRAM_STANDARD_FRAGMENT_ID_ONE = "\u200c";
const TELEGRAM_STANDARD_FRAGMENT_ID_BITS = 32;
const TELEGRAM_STANDARD_FRAGMENT_PREFIX_LENGTH =
  TELEGRAM_STANDARD_FRAGMENT_MARKER.length + 1 + TELEGRAM_STANDARD_FRAGMENT_ID_BITS;
const TELEGRAM_STANDARD_FRAGMENT_CONTENT_LIMIT =
  TELEGRAM_STANDARD_TEXT_LIMIT - TELEGRAM_STANDARD_FRAGMENT_PREFIX_LENGTH;
export const TELEGRAM_STANDARD_FRAGMENT_MAX_PARTS = 32;
export const TELEGRAM_STANDARD_FRAGMENT_MAX_WIRE_CHARS =
  TELEGRAM_STANDARD_TEXT_LIMIT * TELEGRAM_STANDARD_FRAGMENT_MAX_PARTS;

export type TelegramStandardFragmentKind = "start" | "continuation" | "end" | "abort";

export type TelegramStandardFragmentFrame = {
  batchId: string;
  kind: TelegramStandardFragmentKind;
};

export type TelegramStandardTextChunk = {
  htmlText?: string;
  plainText: string;
};

let nextTelegramStandardBatchId = randomBytes(4).readUInt32BE(0);

function createTelegramStandardBatchId(): string {
  const value = nextTelegramStandardBatchId;
  nextTelegramStandardBatchId = (nextTelegramStandardBatchId + 1) >>> 0;
  let encoded = "";
  for (let bit = TELEGRAM_STANDARD_FRAGMENT_ID_BITS - 1; bit >= 0; bit -= 1) {
    encoded +=
      (value >>> bit) & 1 ? TELEGRAM_STANDARD_FRAGMENT_ID_ONE : TELEGRAM_STANDARD_FRAGMENT_ID_ZERO;
  }
  return encoded;
}

function resolveTelegramStandardFragmentKindCode(kind: TelegramStandardFragmentKind): string {
  if (kind === "start") {
    return TELEGRAM_STANDARD_FRAGMENT_START;
  }
  if (kind === "end") {
    return TELEGRAM_STANDARD_FRAGMENT_END;
  }
  return kind === "abort"
    ? TELEGRAM_STANDARD_FRAGMENT_ABORT
    : TELEGRAM_STANDARD_FRAGMENT_CONTINUATION;
}

export function buildTelegramStandardFragmentAbort(text: string): string | undefined {
  const frame = resolveTelegramStandardFragmentFrame(text);
  if (!frame) {
    return undefined;
  }
  return `${TELEGRAM_STANDARD_FRAGMENT_MARKER}${TELEGRAM_STANDARD_FRAGMENT_ABORT}${frame.batchId}`;
}

export function frameTelegramStandardTextFragments(contentChunks: readonly string[]): string[] {
  if (contentChunks.length < 2) {
    return [...contentChunks];
  }
  if (contentChunks.length > TELEGRAM_STANDARD_FRAGMENT_MAX_PARTS) {
    throw new Error(
      `Telegram standard message exceeds the ${TELEGRAM_STANDARD_FRAGMENT_MAX_PARTS}-fragment safety limit`,
    );
  }
  const batchId = createTelegramStandardBatchId();
  return contentChunks.map((chunk, index) => {
    if (chunk.length > TELEGRAM_STANDARD_FRAGMENT_CONTENT_LIMIT) {
      throw new Error("Telegram standard message fragment exceeds the sendMessage limit");
    }
    const kind =
      index === 0 ? "start" : index === contentChunks.length - 1 ? "end" : "continuation";
    return `${TELEGRAM_STANDARD_FRAGMENT_MARKER}${resolveTelegramStandardFragmentKindCode(kind)}${batchId}${chunk}`;
  });
}

function splitObservableTelegramPlainText(text: string): string[] {
  if (text.length <= TELEGRAM_STANDARD_TEXT_LIMIT) {
    return [text];
  }
  const contentChunks: string[] = [];
  let remaining = text;
  while (remaining) {
    if (remaining.length <= TELEGRAM_STANDARD_FRAGMENT_CONTENT_LIMIT) {
      contentChunks.push(remaining);
      break;
    }
    let end = TELEGRAM_STANDARD_FRAGMENT_CONTENT_LIMIT;
    if (splitsSurrogatePair(remaining, end)) {
      end -= 1;
    }
    contentChunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (contentChunks.length > TELEGRAM_STANDARD_FRAGMENT_MAX_PARTS) {
    throw new Error(
      `Telegram standard message exceeds the ${TELEGRAM_STANDARD_FRAGMENT_MAX_PARTS}-fragment safety limit`,
    );
  }
  return frameTelegramStandardTextFragments(contentChunks);
}

function splitsSurrogatePair(text: string, index: number): boolean {
  const finalCodeUnit = text.charCodeAt(index - 1);
  const nextCodeUnit = text.charCodeAt(index);
  return (
    finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  );
}

export function stripTelegramStandardFragmentMarker(text: string): string {
  const frame = resolveTelegramStandardFragmentFrame(text);
  if (!frame) {
    return text;
  }
  return text.slice(TELEGRAM_STANDARD_FRAGMENT_PREFIX_LENGTH);
}

export function resolveTelegramStandardFragmentFrame(
  text: string,
): TelegramStandardFragmentFrame | undefined {
  if (!text.startsWith(TELEGRAM_STANDARD_FRAGMENT_MARKER)) {
    return undefined;
  }
  const kindCode = text.at(TELEGRAM_STANDARD_FRAGMENT_MARKER.length);
  const kind =
    kindCode === TELEGRAM_STANDARD_FRAGMENT_START
      ? "start"
      : kindCode === TELEGRAM_STANDARD_FRAGMENT_CONTINUATION
        ? "continuation"
        : kindCode === TELEGRAM_STANDARD_FRAGMENT_END
          ? "end"
          : kindCode === TELEGRAM_STANDARD_FRAGMENT_ABORT
            ? "abort"
            : undefined;
  if (!kind) {
    return undefined;
  }
  const batchId = text.slice(
    TELEGRAM_STANDARD_FRAGMENT_MARKER.length + 1,
    TELEGRAM_STANDARD_FRAGMENT_PREFIX_LENGTH,
  );
  if (
    batchId.length !== TELEGRAM_STANDARD_FRAGMENT_ID_BITS ||
    [...batchId].some(
      (char) =>
        char !== TELEGRAM_STANDARD_FRAGMENT_ID_ZERO && char !== TELEGRAM_STANDARD_FRAGMENT_ID_ONE,
    )
  ) {
    return undefined;
  }
  return { batchId, kind };
}

export function resolveTelegramStandardFragmentKind(
  text: string,
): TelegramStandardFragmentKind | undefined {
  return resolveTelegramStandardFragmentFrame(text)?.kind;
}

/**
 * Standard peer-bot messages use visible-length chunks so inbound fragment
 * admission sees every non-final chunk as one logical Telegram turn.
 */
export function buildTelegramStandardTextChunks(
  text: string,
  options: { tableMode?: MarkdownTableMode } = {},
): TelegramStandardTextChunk[] {
  const formatted = markdownToTelegramChunks(text, TELEGRAM_STANDARD_TEXT_LIMIT, options);
  if (formatted.length === 0) {
    return splitObservableTelegramPlainText(text).map((plainText) => ({ plainText }));
  }
  if (formatted.length <= 1) {
    return formatted.map((chunk) => ({
      htmlText: chunk.html,
      plainText: telegramHtmlToPlainTextFallback(chunk.html),
    }));
  }

  const renderedPlainText = telegramHtmlToPlainTextFallback(
    renderTelegramHtmlText(text, { tableMode: options.tableMode }),
  );
  const observableText = renderedPlainText || text;
  return splitObservableTelegramPlainText(observableText).map((plainText) => ({ plainText }));
}

export const TELEGRAM_STANDARD_FRAGMENT_ADMISSION_FLOOR = TELEGRAM_FRAGMENT_ADMISSION_FLOOR;
