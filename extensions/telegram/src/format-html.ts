import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { findGraphemeChunkEnd } from "openclaw/plugin-sdk/text-grapheme";

export function escapeTelegramHtml(text: string): string {
  if (!/[&<>]/.test(text)) {
    return text;
  }
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeTelegramHtmlAttr(text: string): string {
  return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

const TELEGRAM_HTML_ENTITY_PATTERN = /&(#(?:[xX][0-9A-Fa-f]+|\d+)|[A-Za-z0-9]+);/g;
const TELEGRAM_HTML_ENTITY_AT = new RegExp(TELEGRAM_HTML_ENTITY_PATTERN.source, "y");

// Structural tags that force a line boundary when projecting HTML to plain text
// (assistant transcript protection). Block-counting helpers for rich HTML are gone.
const TELEGRAM_LINE_BREAK_STRUCTURAL_TAGS = new Set([
  "aside",
  "audio",
  "blockquote",
  "caption",
  "col",
  "colgroup",
  "details",
  "figcaption",
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
  "summary",
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

export function isTelegramRichLineBreakStructuralTag(rawTag: string, tagName: string): boolean {
  return (
    TELEGRAM_LINE_BREAK_STRUCTURAL_TAGS.has(tagName) ||
    (tagName === "a" && /\sname="[^"]+"/i.test(rawTag))
  );
}

function isValidTelegramHtmlEntityCodePoint(codePoint: number): boolean {
  return (
    Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

function decodeTelegramHtmlEntity(entity: string, fallback: string): string {
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const codePoint = Number.parseInt(entity.slice(2), 16);
    return isValidTelegramHtmlEntityCodePoint(codePoint)
      ? String.fromCodePoint(codePoint)
      : fallback;
  }
  if (entity.startsWith("#")) {
    const codePoint = Number.parseInt(entity.slice(1), 10);
    return isValidTelegramHtmlEntityCodePoint(codePoint)
      ? String.fromCodePoint(codePoint)
      : fallback;
  }
  switch (entity) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
    default:
      return fallback;
  }
}

export function decodeTelegramHtmlEntities(text: string): string {
  return text.replace(TELEGRAM_HTML_ENTITY_PATTERN, (match, entity: string) =>
    decodeTelegramHtmlEntity(entity, match),
  );
}

export function findTelegramHtmlEntityEnd(text: string, start: number): number {
  TELEGRAM_HTML_ENTITY_AT.lastIndex = start;
  const match = TELEGRAM_HTML_ENTITY_AT.exec(text);
  return match?.index === start ? TELEGRAM_HTML_ENTITY_AT.lastIndex - 1 : -1;
}

type TelegramHtmlTextEntity = {
  sourceStart: number;
  sourceEnd: number;
  decodedStart: number;
  decodedEnd: number;
};

function mapTelegramHtmlTextOffset(
  entities: readonly TelegramHtmlTextEntity[],
  offset: number,
  to: "source" | "decoded",
): number {
  let low = 0;
  let high = entities.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = expectDefined(
      entities[middle],
      "Telegram HTML entity binary-search midpoint",
    );
    const start = to === "source" ? candidate.decodedStart : candidate.sourceStart;
    if (start <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const entity = entities[low - 1];
  if (!entity) {
    return offset;
  }
  const fromEnd = to === "source" ? entity.decodedEnd : entity.sourceEnd;
  const toStart = to === "source" ? entity.sourceStart : entity.decodedStart;
  const toEnd = to === "source" ? entity.sourceEnd : entity.decodedEnd;
  return offset < fromEnd ? toStart : toEnd + offset - fromEnd;
}

function findTelegramHtmlWordSafeSplitIndex(text: string, start: number, end: number): number {
  let lastNewline = start;
  let lastWhitespace = start;
  for (let index = start + 1; index < end; index += 1) {
    const char = text[index];
    if (char === "\n") {
      lastNewline = index + 1;
    } else if (char !== undefined && /\s/.test(char)) {
      lastWhitespace = index + 1;
    }
  }
  return lastNewline > start ? lastNewline : lastWhitespace;
}

export type TelegramHtmlTextSplitter = (
  start: number,
  maxLength: number,
  allowPartialGrapheme: boolean,
) => number;

/** Prepares one text segment; returned cuts are offsets in its original HTML spelling. */
export function prepareTelegramHtmlTextSplitter(source: string): TelegramHtmlTextSplitter {
  // Each entity becomes one scalar for segmentation. Opaque spellings use "&":
  // like their literal "&" and ";" edges, it attaches to Prepend and Extend.
  // Sparse spans keep every returned cut outside the original entity spelling.
  const entities: TelegramHtmlTextEntity[] = [];
  const parts: string[] = [];
  let sourceOffset = 0;
  let decodedLength = 0;
  for (const match of source.matchAll(TELEGRAM_HTML_ENTITY_PATTERN)) {
    const sourceEnd = match.index + match[0].length;
    const prefix = source.slice(sourceOffset, match.index);
    const decodedEntity = decodeTelegramHtmlEntity(match[0].slice(1, -1), "&");
    parts.push(prefix, decodedEntity);
    decodedLength += prefix.length;
    entities.push({
      sourceStart: match.index,
      sourceEnd,
      decodedStart: decodedLength,
      decodedEnd: decodedLength + decodedEntity.length,
    });
    decodedLength += decodedEntity.length;
    sourceOffset = sourceEnd;
  }
  parts.push(source.slice(sourceOffset));
  const decoded = entities.length > 0 ? parts.join("") : source;

  return (start: number, maxLength: number, allowPartialGrapheme: boolean): number => {
    const sourceEnd = start + maxLength;
    const preferredEnd = findTelegramHtmlWordSafeSplitIndex(source, start, sourceEnd);
    return mapTelegramHtmlTextOffset(
      entities,
      findGraphemeChunkEnd(
        decoded,
        mapTelegramHtmlTextOffset(entities, start, "decoded"),
        mapTelegramHtmlTextOffset(entities, sourceEnd, "decoded"),
        mapTelegramHtmlTextOffset(entities, preferredEnd, "decoded"),
        allowPartialGrapheme,
      ),
      "source",
    );
  };
}
