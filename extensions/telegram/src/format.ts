import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
// Telegram helper module supports format behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  FILE_REF_EXTENSIONS_WITH_TLD,
  findCodeRegions,
  isAutoLinkedFileRef,
  isInsideCode,
  markdownToIR,
  type MarkdownLinkSpan,
  type MarkdownIR,
  renderMarkdownIRChunksWithinLimit,
  tokenizeHtmlTags,
} from "openclaw/plugin-sdk/text-chunking";
import {
  protectTelegramAssistantTranscriptRoleHeaders,
  TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX,
} from "./format-assistant-transcript.js";
import {
  decodeTelegramHtmlEntities,
  escapeTelegramHtml,
  escapeTelegramHtmlAttr,
  findTelegramHtmlEntityEnd,
  prepareTelegramHtmlTextSplitter,
  type TelegramHtmlTextSplitter,
} from "./format-html.js";
import { renderTelegramMarkdownIR } from "./format-render.js";
import { renderTelegramMonospaceGrid } from "./text-width.js";

export { escapeTelegramHtml } from "./format-html.js";

export type TelegramFormattedChunk = {
  html: string;
  text: string;
};

function isTelegramRichLinkHref(href: string): boolean {
  return /^(?:https?:\/\/|tg:\/\/|mailto:|tel:|#)/i.test(href);
}

/**
 * File extensions that share TLDs and commonly appear in code/documentation.
 * These are wrapped in <code> tags to prevent Telegram from generating
 * spurious domain registrar previews.
 *
 * Only includes extensions that are:
 * 1. Commonly used as file extensions in code/docs
 * 2. Rarely used as intentional domain references
 *
 * Excluded: .ai, .io, .tv, .fm (popular domain TLDs like x.ai, vercel.io, github.io)
 */
function buildTelegramLink(
  link: MarkdownLinkSpan,
  text: string,
  context: { origin: "authored" | "linkify" },
) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  if (link.start === link.end) {
    return null;
  }
  // Telegram rich links reject local or relative hrefs; keep the label visible
  // instead of letting one unsupported link drop the whole message.
  if (!isTelegramRichLinkHref(href)) {
    return null;
  }
  // Suppress auto-linkified file references (e.g. README.md → http://README.md)
  const label = text.slice(link.start, link.end);
  if (context.origin === "linkify" && isAutoLinkedFileRef(href, label)) {
    return null;
  }
  const safeHref = escapeTelegramHtmlAttr(href);
  return {
    start: link.start,
    end: link.end,
    open: `<a href="${safeHref}">`,
    close: "</a>",
  };
}

function buildTelegramCodeBlockOpen(span: { language?: string }): string {
  if (!span.language) {
    return "<pre><code>";
  }
  return `<pre><code class="language-${escapeTelegramHtmlAttr(span.language)}">`;
}

function renderTelegramHtml(ir: MarkdownIR): string {
  return renderTelegramMarkdownIR(ir, {
    escapeText: escapeTelegramHtml,
    buildLink: buildTelegramLink,
    buildCodeBlockOpen: buildTelegramCodeBlockOpen,
  });
}

function leadingWhitespaceLength(line: string): number {
  let length = 0;
  while (line[length] === " " || line[length] === "\t") {
    length++;
  }
  return length;
}

function isTelegramBulletLine(line: string): boolean {
  return /^[ \t]*(?:[•*+-])[ \t]+\S/.test(line);
}

function isTelegramListBoundaryLine(line: string): boolean {
  return /^[ \t]*(?:\d+\.|#{1,6})[ \t]+\S/.test(line);
}

function shouldPreserveTelegramListBoundarySpacing(previous: string, next: string): boolean {
  return (
    isTelegramBulletLine(previous) &&
    isTelegramListBoundaryLine(next) &&
    leadingWhitespaceLength(next) <= leadingWhitespaceLength(previous)
  );
}

function preserveTelegramListBoundarySpacing(markdown: string): string {
  // Preserve literal fence examples and indented code when separating prose lists.
  let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
  let previousLine = "";
  let previousOffset = 0;
  let offset = 0;
  return markdown
    .split("\n")
    .map((line) => {
      const normalizedLine = line.replace(/\r$/, "");
      const insertBoundary =
        shouldPreserveTelegramListBoundarySpacing(previousLine, normalizedLine) &&
        !isInsideCode(previousOffset, (codeRegions ??= findCodeRegions(markdown))) &&
        !isInsideCode(offset, codeRegions);
      previousLine = normalizedLine;
      previousOffset = offset;
      offset += line.length + 1;
      return insertBoundary ? `\n${line}` : line;
    })
    .join("\n");
}

function parseTelegramLegacyMarkdown(markdown: string, tableMode?: MarkdownTableMode): MarkdownIR {
  return markdownToIR(preserveTelegramListBoundarySpacing(markdown ?? ""), {
    assistantTranscriptRoleHeaders: true,
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: tableMode === "block" ? "code" : tableMode,
  });
}

export function markdownToTelegramHtml(
  markdown: string,
  options: { tableMode?: MarkdownTableMode; wrapFileRefs?: boolean } = {},
): string {
  const ir = parseTelegramLegacyMarkdown(markdown, options.tableMode);
  const html = renderTelegramHtml(ir);
  const telegramHtml = renderSupportedTelegramHtml(html);
  // Apply file reference wrapping if requested (for chunked rendering)
  if (options.wrapFileRefs !== false) {
    return wrapFileReferencesInHtml(telegramHtml);
  }
  return telegramHtml;
}

/**
 * Wraps standalone file references (with TLD extensions) in <code> tags.
 * This prevents Telegram from treating them as URLs and generating
 * irrelevant domain registrar previews.
 *
 * Runs AFTER markdown→HTML conversion to avoid modifying HTML attributes.
 * Skips content inside <code>, <pre>, and <a> tags to avoid nesting issues.
 */
/** Escape regex metacharacters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HTML_MODE_TAG_PATTERN = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>$/;
const ESCAPED_HTML_TAG_PATTERN = /&lt;(\/?)([a-zA-Z][a-zA-Z0-9-]*)(.*?)&gt;/g;
const TELEGRAM_HTML_ANCHOR_PATTERN =
  /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
const TELEGRAM_HTML_BREAK_PATTERN = /<br\s*\/?>/gi;
const TELEGRAM_HTML_TAG_PATTERN = /<[^>]*>/g;
const TELEGRAM_RICH_HTML_TABLE_PATTERN = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
const TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const TELEGRAM_HTML_CAPTION_PATTERN = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i;
const TELEGRAM_HTML_COLSPAN_PATTERN = /(?:^|\s)colspan\s*=\s*(['"]?)\s*(\d+)\s*\1(?=\s|$)/i;
const TELEGRAM_SIMPLE_HTML_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "pre",
  "tg-spoiler",
]);
const TELEGRAM_ATTR_HTML_TAG_PATTERNS = new Map([
  ["a", /^\s+href="[^"]+"\s*$/],
  ["span", /^\s+class="tg-spoiler"\s*$/],
  ["tg-emoji", /^\s+emoji-id="[^"]+"\s*$/],
  ["tg-time", /^\s+unix="[1-9]\d*"(?:\s+format="(?:r|w?[dD]?[tT]?)")?\s*$/],
  ["blockquote", /^(\s+expandable)?\s*$/],
]);
const TELEGRAM_CODE_LANGUAGE_ATTR_PATTERN = /^\s+class="language-[^"]+"\s*$/;

let fileReferencePattern: RegExp | undefined;
let orphanedTldPattern: RegExp | undefined;

function popLastTagName(tags: string[], name: string): boolean {
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    if (tags[index] === name) {
      tags.splice(index, 1);
      return true;
    }
  }
  return false;
}

function isSupportedTelegramHtmlTag(closing: boolean, name: string, attrs: string): boolean {
  if (closing) {
    return (
      attrs.trim() === "" &&
      (TELEGRAM_SIMPLE_HTML_TAGS.has(name) || TELEGRAM_ATTR_HTML_TAG_PATTERNS.has(name))
    );
  }
  if (TELEGRAM_ATTR_HTML_TAG_PATTERNS.get(name)?.test(attrs)) {
    return true;
  }
  return TELEGRAM_SIMPLE_HTML_TAGS.has(name) && attrs.trim() === "";
}

function preserveTelegramHtmlTag(
  rawTag: string,
  openTags: string[],
  escapeTag: (rawTag: string) => string,
): string {
  const match = HTML_MODE_TAG_PATTERN.exec(rawTag);
  if (!match) {
    return escapeTag(rawTag);
  }
  const closing = match[1] === "/";
  const tagName = normalizeLowercaseStringOrEmpty(match[2]);
  const attrs = match[3] ?? "";
  if (!closing && tagName === "code" && TELEGRAM_CODE_LANGUAGE_ATTR_PATTERN.test(attrs)) {
    openTags.push(tagName);
    if (openTags.includes("pre")) {
      return rawTag;
    }
    return "<code>";
  }
  if (!isSupportedTelegramHtmlTag(closing, tagName, attrs)) {
    return escapeTag(rawTag);
  }
  if (closing) {
    return popLastTagName(openTags, tagName) ? rawTag : escapeTag(rawTag);
  }
  if (rawTag.trimEnd().endsWith("/>")) {
    return rawTag;
  }
  openTags.push(tagName);
  return rawTag;
}

function escapeUnsupportedTelegramHtml(text: string): string {
  let result = "";
  let index = 0;
  const openTags: string[] = [];
  while (index < text.length) {
    const char = text[index];
    if (char === "&") {
      const entityEnd = findTelegramHtmlEntityEnd(text, index);
      if (entityEnd !== -1) {
        result += text.slice(index, entityEnd + 1);
        index = entityEnd + 1;
      } else {
        result += "&amp;";
        index += 1;
      }
      continue;
    }
    if (char === "<") {
      const end = text.indexOf(">", index + 1);
      if (end !== -1) {
        const rawTag = text.slice(index, end + 1);
        result += preserveTelegramHtmlTag(rawTag, openTags, escapeTelegramHtml);
        index = end + 1;
      } else {
        result += "&lt;";
        index += 1;
      }
      continue;
    }
    if (char === ">") {
      result += "&gt;";
      index += 1;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

export function resolveTelegramHtmlVisibleText(html: string): string {
  return decodeTelegramHtmlEntities(
    html.replace(TELEGRAM_HTML_BREAK_PATTERN, "\n").replace(TELEGRAM_HTML_TAG_PATTERN, ""),
  );
}

export function countTelegramHtmlVisibleCharacters(html: string): number {
  // Telegram limits UTF-16 caption characters after stripping markup and decoding entities.
  return resolveTelegramHtmlVisibleText(html).length;
}

export function telegramHtmlToPlainTextFallback(html: string): string {
  const withPlainTables = html.replace(TELEGRAM_RICH_HTML_TABLE_PATTERN, (tableHtml) => {
    const rows = parseTelegramRichHtmlTableRows(tableHtml);
    return rows.map((row) => row.join(" | ")).join("\n");
  });
  TELEGRAM_HTML_ANCHOR_PATTERN.lastIndex = 0;
  const withPlainLinks = withPlainTables.replace(
    TELEGRAM_HTML_ANCHOR_PATTERN,
    (
      _match: string,
      doubleQuotedHref: string | undefined,
      singleQuotedHref: string | undefined,
      unquotedHref: string | undefined,
      labelHtml: string,
    ) => {
      const href = decodeTelegramHtmlEntities(
        doubleQuotedHref ?? singleQuotedHref ?? unquotedHref ?? "",
      ).trim();
      const label = resolveTelegramHtmlVisibleText(labelHtml).trim();
      if (!href) {
        return escapeTelegramHtml(label);
      }
      return escapeTelegramHtml(!label || label === href ? href : `${label} (${href})`);
    },
  );
  return resolveTelegramHtmlVisibleText(withPlainLinks);
}

function promoteEscapedSupportedTelegramTags(text: string, openTags: string[]): string {
  ESCAPED_HTML_TAG_PATTERN.lastIndex = 0;
  return text.replace(
    ESCAPED_HTML_TAG_PATTERN,
    (match, closing: string, name: string, attrs: string) =>
      preserveTelegramHtmlTag(`<${closing}${name}${attrs}>`, openTags, () => match),
  );
}

function transformUnprotectedTelegramHtmlText(
  html: string,
  protectedTags: readonly string[],
  transformText: (text: string) => string,
): string {
  const depths = protectedTags.map((name) => ({ name, depth: 0 }));
  let result = "";
  let lastIndex = 0;
  const transform = (text: string) =>
    depths.some(({ depth }) => depth > 0) ? text : transformText(text);
  for (const tag of tokenizeHtmlTags(html)) {
    result += transform(html.slice(lastIndex, tag.start));
    const tracked = depths.find(({ name }) => name === tag.name);
    if (tracked) {
      tracked.depth = tag.closing ? Math.max(0, tracked.depth - 1) : tracked.depth + 1;
    }
    result += html.slice(tag.start, tag.end);
    lastIndex = tag.end;
  }
  return result + transform(html.slice(lastIndex));
}

function renderSupportedTelegramHtml(html: string): string {
  const openEscapedTags: string[] = [];
  const promoted = html.includes("&lt;")
    ? transformUnprotectedTelegramHtmlText(html, ["code", "pre"], (text) =>
        promoteEscapedSupportedTelegramTags(text, openEscapedTags),
      )
    : html;
  return protectTelegramAssistantTranscriptRoleHeaders(promoted);
}

function getFileReferencePattern(): RegExp {
  if (fileReferencePattern) {
    return fileReferencePattern;
  }
  const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
  fileReferencePattern = new RegExp(
    `(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${fileExtensionsPattern}))(?=$|[^a-zA-Z0-9_\\-/])`,
    "gi",
  );
  return fileReferencePattern;
}

function getOrphanedTldPattern(): RegExp {
  if (orphanedTldPattern) {
    return orphanedTldPattern;
  }
  const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
  orphanedTldPattern = new RegExp(
    `([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${fileExtensionsPattern}))(?=[^a-zA-Z0-9/]|$)`,
    "g",
  );
  return orphanedTldPattern;
}

function wrapStandaloneFileRef(match: string, prefix: string, filename: string): string {
  if (filename.startsWith("//")) {
    return match;
  }
  if (/https?:\/\/$/i.test(prefix)) {
    return match;
  }
  return `${prefix}<code>${escapeTelegramHtml(filename)}</code>`;
}

function wrapSegmentFileRefs(text: string): string {
  if (!text.includes(".")) {
    return text;
  }
  const wrappedStandalone = text.replace(getFileReferencePattern(), wrapStandaloneFileRef);
  return wrappedStandalone.replace(getOrphanedTldPattern(), (match, prefix: string, tld: string) =>
    prefix === ">" ? match : `${prefix}<code>${escapeTelegramHtml(tld)}</code>`,
  );
}

export function wrapFileReferencesInHtml(html: string): string {
  return transformUnprotectedTelegramHtmlText(html, ["code", "pre", "a"], wrapSegmentFileRefs);
}

export function renderTelegramHtmlText(
  text: string,
  options: { textMode?: "markdown" | "html"; tableMode?: MarkdownTableMode } = {},
): string {
  const textMode = options.textMode ?? "markdown";
  if (textMode === "html") {
    return escapeUnsupportedTelegramHtml(normalizeTelegramLegacyHtmlTables(text));
  }
  // markdownToTelegramHtml already wraps file references by default
  return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}

function normalizeTelegramLegacyHtmlTables(html: string): string {
  const tags = tokenizeHtmlTags(html);
  const depth = { code: 0, pre: 0 };
  let nextTag: ReturnType<typeof tags.next> | undefined;
  TELEGRAM_RICH_HTML_TABLE_PATTERN.lastIndex = 0;
  return html.replace(TELEGRAM_RICH_HTML_TABLE_PATTERN, (tableHtml, offset: number) => {
    nextTag ??= tags.next();
    // Table offsets increase in the original HTML. Keep the next tag pending
    // so each table sees its exact code context without rescanning earlier tags.
    while (!nextTag.done && nextTag.value.start < offset) {
      const { name, closing } = nextTag.value;
      if (name === "code" || name === "pre") {
        depth[name] = closing ? Math.max(0, depth[name] - 1) : depth[name] + 1;
      }
      nextTag = tags.next();
    }
    if (depth.code > 0 || depth.pre > 0) {
      return tableHtml;
    }
    const rows = parseTelegramRichHtmlTableRows(tableHtml);
    return rows.length ? renderTelegramRichHtmlRawTableFallback(tableHtml, rows) : tableHtml;
  });
}

function parseTelegramHtmlColspan(attrs: string): number {
  const raw = TELEGRAM_HTML_COLSPAN_PATTERN.exec(attrs)?.[2];
  const value = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(value) && value > 1 ? Math.min(value, 21) : 1;
}

function parseTelegramRichHtmlTableRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN.lastIndex = 0;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN.exec(tableHtml)) !== null) {
    const rowHtml = rowMatch[1] ?? "";
    const row: string[] = [];
    TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN.exec(rowHtml)) !== null) {
      const attrs = cellMatch[2] ?? "";
      const text = telegramHtmlToPlainTextFallback(cellMatch[3] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      row.push(text, ...Array.from({ length: parseTelegramHtmlColspan(attrs) - 1 }, () => ""));
    }
    if (row.length) {
      rows.push(row);
    }
  }
  return rows;
}

function renderTelegramRichHtmlRawTableFallback(
  tableHtml: string,
  rows: readonly string[][],
): string {
  const caption = telegramHtmlToPlainTextFallback(
    TELEGRAM_HTML_CAPTION_PATTERN.exec(tableHtml)?.[1] ?? "",
  ).trim();
  const tableText = renderTelegramMonospaceGrid(rows);
  return `<pre><code>${escapeTelegramHtml([caption, tableText].filter(Boolean).join("\n"))}</code></pre>\n\n`;
}

type TelegramHtmlTag = {
  name: string;
  openTag: string;
  closeTag: string;
};

function buildTelegramHtmlOpenPrefix(tags: TelegramHtmlTag[]): string {
  return tags.map((tag) => tag.openTag).join("");
}

function buildTelegramHtmlCloseSuffix(tags: TelegramHtmlTag[]): string {
  return tags
    .slice()
    .toReversed()
    .map((tag) => tag.closeTag)
    .join("");
}

function buildTelegramHtmlCloseSuffixLength(tags: TelegramHtmlTag[]): number {
  return tags.reduce((total, tag) => total + tag.closeTag.length, 0);
}

function popTelegramHtmlTag(tags: TelegramHtmlTag[], name: string): void {
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    if (tags[index]?.name === name) {
      tags.splice(index, 1);
      return;
    }
  }
}

function splitTelegramHtmlChunksRaw(html: string, normalizedLimit: number): string[] {
  if (!html) {
    return [];
  }
  if (html.length <= normalizedLimit) {
    return [html];
  }

  const chunks: string[] = [];
  const openTags: TelegramHtmlTag[] = [];
  const suppressedTagNames: string[] = [];
  let current = "";
  let chunkHasPayload = false;

  const resetCurrent = () => {
    current = buildTelegramHtmlOpenPrefix(openTags);
    chunkHasPayload = false;
  };

  const flushCurrent = () => {
    if (!chunkHasPayload) {
      return;
    }
    chunks.push(`${current}${buildTelegramHtmlCloseSuffix(openTags)}`);
    resetCurrent();
  };

  const appendText = (segment: string) => {
    let findSplitIndex: TelegramHtmlTextSplitter | undefined;
    let start = 0;
    while (start < segment.length) {
      const available =
        normalizedLimit - current.length - buildTelegramHtmlCloseSuffixLength(openTags);
      let splitAt = start;
      if (available > 0) {
        if (segment.length - start <= available) {
          splitAt = segment.length;
        } else {
          findSplitIndex ??= prepareTelegramHtmlTextSplitter(segment);
          splitAt = findSplitIndex(start, available, current.length === 0);
        }
      }
      if (chunkHasPayload && splitAt <= start) {
        flushCurrent();
        continue;
      }
      if (current.length > 0 && (splitAt <= start || splitAt - start > available)) {
        // Discard empty tag overhead, suppressing only active scopes that block the next payload.
        suppressedTagNames.push(...openTags.map((tag) => tag.name));
        openTags.length = 0;
        resetCurrent();
        continue;
      }
      if (splitAt <= start) {
        throw new Error(
          `Telegram HTML chunk limit exceeded by leading entity (limit=${normalizedLimit})`,
        );
      }
      current += segment.slice(start, splitAt);
      chunkHasPayload = true;
      start = splitAt;
      if (start < segment.length) {
        flushCurrent();
      }
    }
  };

  resetCurrent();
  let lastIndex = 0;
  for (const tag of tokenizeHtmlTags(html)) {
    const tagStart = tag.start;
    const tagEnd = tag.end;
    appendText(html.slice(lastIndex, tagStart));

    const rawTag = tag.raw;
    const isClosing = tag.closing;
    const tagName = tag.name;
    const isSelfClosing = !isClosing && rawTag.trimEnd().endsWith("/>");

    if (!isClosing) {
      const nextCloseLength = isSelfClosing ? 0 : `</${tagName}>`.length;
      if (
        chunkHasPayload &&
        current.length +
          rawTag.length +
          buildTelegramHtmlCloseSuffixLength(openTags) +
          nextCloseLength >
          normalizedLimit
      ) {
        flushCurrent();
      }
    }

    const closesOpenTag = isClosing && openTags.some((openTag) => openTag.name === tagName);
    const closesSuppressedTag =
      isClosing && !closesOpenTag && popLastTagName(suppressedTagNames, tagName);
    if (!closesSuppressedTag) {
      current += rawTag;
    }
    if (isSelfClosing) {
      chunkHasPayload = true;
    }
    if (isClosing) {
      popTelegramHtmlTag(openTags, tagName);
    } else if (!isSelfClosing) {
      openTags.push({
        name: tagName,
        openTag: rawTag,
        closeTag: `</${tagName}>`,
      });
    }
    lastIndex = tagEnd;
  }

  appendText(html.slice(lastIndex));
  flushCurrent();
  return chunks.length > 0 ? chunks : [html];
}

export function splitTelegramHtmlChunks(html: string, limit: number): string[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  if (Number.isNaN(normalizedLimit)) {
    throw new TypeError("Telegram HTML chunk limit must be numeric");
  }
  const chunks = splitTelegramHtmlChunksRaw(html, normalizedLimit);
  if (chunks.every((chunk) => protectTelegramAssistantTranscriptRoleHeaders(chunk) === chunk)) {
    return chunks;
  }

  const protectedContentLimit = normalizedLimit - TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX.length;
  if (protectedContentLimit < 1) {
    throw new Error(
      `Telegram HTML chunk limit cannot fit assistant transcript marker (limit=${normalizedLimit})`,
    );
  }
  return splitTelegramHtmlChunksRaw(html, protectedContentLimit).map((chunk) =>
    protectTelegramAssistantTranscriptRoleHeaders(chunk),
  );
}

function renderTelegramChunkHtml(ir: MarkdownIR): string {
  return wrapFileReferencesInHtml(renderSupportedTelegramHtml(renderTelegramHtml(ir)));
}

export function markdownToTelegramChunks(
  markdown: string,
  limit: number,
  options: { tableMode?: MarkdownTableMode } = {},
): TelegramFormattedChunk[] {
  const ir = parseTelegramLegacyMarkdown(markdown, options.tableMode);
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    renderChunk: renderTelegramChunkHtml,
    measureRendered: (html) => html.length,
  }).map(({ source, rendered }) => ({
    html: rendered,
    text: source.text,
  }));
}

export function markdownToTelegramHtmlChunks(
  markdown: string,
  limit: number,
  options: { tableMode?: MarkdownTableMode } = {},
): string[] {
  return markdownToTelegramChunks(markdown, limit, options).map((chunk) => chunk.html);
}
