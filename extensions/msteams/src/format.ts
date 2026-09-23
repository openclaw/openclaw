import { randomUUID } from "node:crypto";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { getMarkdownTableSource } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  convertMarkdownTables,
  FormatCapabilityProfile,
  type MarkdownIR,
  markdownToIR,
  markdownToIRWithMeta,
  renderMarkdownWithMarkers,
} from "openclaw/plugin-sdk/text-chunking";
import type { MarkdownTableMode } from "../runtime-api.js";

const ESCAPED_MARKDOWN_RE = /\\[\\`*_{}[\]()#+\-.!|>~]/gu;
const MARKDOWN_ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/giu;
const TOKEN_END = "\u{E002}";

// Teams supports strikethrough on desktop and iOS, but not Android.
const MSTEAMS_FORMAT_CAPABILITIES = FormatCapabilityProfile.define({
  mechanism: "markdown",
  constructs: {
    underline: "strip",
    spoiler: "fallback",
    codeLanguage: "fallback",
    heading: "fallback",
    bulletList: "fallback",
    orderedList: "fallback",
    taskList: "fallback",
    table: "fallback",
  },
  chunk: { limit: 80_000, unit: "utf16", hardCap: 100_000 },
});

const MSTEAMS_MARKERS = {
  bold: { open: "**", close: "**" },
  italic: { open: "*", close: "*" },
  strikethrough: { open: "~~", close: "~~" },
} as const;

function createTokenPrefix(text: string, label: string): string {
  // With these parser options, the leading marker must be literal or entity-decoded.
  const normalized = /[\u{E000}&]/u.test(text)
    ? markdownToIR(text, { autolink: false, linkify: false }).text
    : "";
  let prefix: string;
  do {
    prefix = `\u{E000}${label}-${randomUUID()}\u{E001}`;
  } while (text.includes(prefix) || normalized.includes(prefix));
  return prefix;
}

function restoreTokens(text: string, prefix: string, values: readonly string[]): string {
  // Empty value tables can still have matching markers after normalization.
  if (!text.includes(prefix)) {
    return text;
  }
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return text.replace(
    new RegExp(`${escapedPrefix}(\\d+)${TOKEN_END}`, "gu"),
    (_token, index: string) => values[Number(index)] ?? "",
  );
}

type TextEdit = { start: number; end: number; text: string };

function rewriteMarkdownIR(ir: MarkdownIR, edits: readonly TextEdit[]): MarkdownIR {
  const ordered = edits.toSorted((a, b) => a.start - b.start);
  const cumulativeDeltas: number[] = [];
  const exactEdits = new Map<string, TextEdit>();
  let text = "";
  let cursor = 0;
  let delta = 0;
  for (const edit of ordered) {
    text += ir.text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
    delta += edit.text.length - (edit.end - edit.start);
    cumulativeDeltas.push(delta);
    exactEdits.set(`${edit.start}:${edit.end}`, edit);
  }
  text += ir.text.slice(cursor);
  const mapOffset = (offset: number): number => {
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if ((ordered[middle]?.end ?? Number.POSITIVE_INFINITY) <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return offset + (low > 0 ? (cumulativeDeltas[low - 1] ?? 0) : 0);
  };
  const mapRange = <T extends { start: number; end: number }>(range: T): T => {
    const exact = exactEdits.get(`${range.start}:${range.end}`);
    const start = mapOffset(range.start);
    return { ...range, start, end: exact ? start + exact.text.length : mapOffset(range.end) };
  };
  return {
    ...ir,
    text,
    styles: ir.styles.map(mapRange),
    links: ir.links.map(mapRange),
    ...(ir.annotations ? { annotations: ir.annotations.map(mapRange) } : {}),
    ...(ir.listItems
      ? {
          listItems: ir.listItems.map((item) => ({
            ...item,
            ...(item.listMarker ? { listMarker: mapRange(item.listMarker) } : {}),
            ...(item.taskMarker ? { taskMarker: mapRange(item.taskMarker) } : {}),
          })),
        }
      : {}),
  };
}

function prefixMSTeamsBlockquotes(ir: MarkdownIR): MarkdownIR {
  const quoteSpans = ir.styles.filter((span) => span.style === "blockquote");
  const edits = quoteSpans.flatMap((span) => {
    const positions = [span.start];
    for (let index = span.start; index < span.end; index += 1) {
      if (ir.text[index] === "\n" && index + 1 < span.end) {
        positions.push(index + 1);
      }
    }
    return positions.map((position) => ({ start: position, end: position, text: "> " }));
  });
  const rewritten = rewriteMarkdownIR(ir, edits);
  return {
    ...rewritten,
    styles: rewritten.styles.filter((span) => span.style !== "blockquote"),
  };
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/gu)?.map((run) => run.length) ?? []));
}

function renderMSTeamsCode(style: "code" | "code_block", text: string): string {
  const marker = "`".repeat(Math.max(style === "code_block" ? 3 : 1, longestBacktickRun(text) + 1));
  if (style === "code_block") {
    return `${marker}\n${text}${marker}`;
  }
  const needsPadding =
    text.startsWith("`") ||
    text.endsWith("`") ||
    (text.startsWith(" ") && text.endsWith(" ") && text.trim().length > 0);
  return `${marker}${needsPadding ? " " : ""}${text}${needsPadding ? " " : ""}${marker}`;
}

function serializeMarkdownDestination(href: string): string {
  return `<${href.replace(/([\\<>])/gu, "\\$1")}>`;
}

type DelimitedMarkdownScan = { end: number } | { next: number } | undefined;

function blankBlockEnd(text: string, index: number): number | undefined {
  if (text[index] !== "\n" && text[index] !== "\r") {
    return undefined;
  }
  const match = /^(?:\r?\n)[ \t]*(?:\r?\n)/u.exec(text.slice(index));
  return match ? index + match[0].length : undefined;
}

function scanDelimitedMarkdown(
  text: string,
  start: number,
  nestedOpener: "![" | "@[",
): DelimitedMarkdownScan {
  let bracketDepth = 1;
  let altEnd: number | undefined;
  let fallbackNext: number | undefined;
  for (let index = start + 2; index < text.length; index += 1) {
    const blankEnd = blankBlockEnd(text, index);
    if (blankEnd !== undefined) {
      return { next: fallbackNext ?? blankEnd };
    }
    if (text[index] === "\\") {
      index += 1;
    } else if (text.startsWith(nestedOpener, index)) {
      fallbackNext = index;
      bracketDepth += 1;
      index += 1;
    } else if (text[index] === "[") {
      bracketDepth += 1;
    } else if (text[index] === "]" && --bracketDepth === 0) {
      altEnd = index;
      break;
    }
  }
  if (altEnd === undefined || text[altEnd + 1] !== "(") {
    const next =
      fallbackNext ?? text.indexOf(nestedOpener, altEnd === undefined ? start + 2 : altEnd + 1);
    return next < 0 ? undefined : { next };
  }
  let parenDepth = 1;
  for (let index = altEnd + 2; index < text.length; index += 1) {
    const blankEnd = blankBlockEnd(text, index);
    if (blankEnd !== undefined) {
      return { next: fallbackNext ?? blankEnd };
    }
    if (text[index] === "\\") {
      index += 1;
    } else if (text.startsWith(nestedOpener, index)) {
      fallbackNext = index;
    } else if (text[index] === "(") {
      parenDepth += 1;
    } else if (text[index] === ")" && --parenDepth === 0) {
      return { end: index + 1 };
    }
  }
  return fallbackNext === undefined ? undefined : { next: fallbackNext };
}

function protectDelimitedMarkdown(
  text: string,
  opener: "![" | "@[",
  tokenPrefix: string,
  values: string[],
): string {
  let protectedText = "";
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf(opener, searchFrom);
    if (start < 0) {
      break;
    }
    const scan = scanDelimitedMarkdown(text, start, opener);
    if (!scan) {
      break;
    }
    if ("next" in scan) {
      searchFrom = scan.next;
      continue;
    }
    protectedText += text.slice(cursor, start);
    const index = values.push(text.slice(start, scan.end)) - 1;
    protectedText += `${tokenPrefix}${index}${TOKEN_END}`;
    cursor = scan.end;
    searchFrom = scan.end;
  }
  return protectedText + text.slice(cursor);
}

function protectRawTables(text: string, tokenPrefix: string, rawTables: string[]): string {
  if (!text.includes("|")) {
    return text;
  }
  const { tables } = markdownToIRWithMeta(text, {
    autolink: false,
    linkify: false,
    tableMode: "block",
  });
  let result = "";
  let cursor = 0;
  for (const table of tables) {
    const source = expectDefined(getMarkdownTableSource(table), "Markdown table source");
    // Preserve raw indentation and CRLF trivia without hiding the enclosing quote markers.
    const lineStart =
      Math.max(text.lastIndexOf("\n", source.start - 1), text.lastIndexOf("\r", source.start - 1)) +
      1;
    const quotePrefix = /^(?: {0,3}>[ \t]?)*/u.exec(text.slice(lineStart, source.start))?.[0] ?? "";
    const start = lineStart + quotePrefix.length;
    const end = source.end + (text.slice(source.end, source.end + 2) === "\r\n" ? 1 : 0);
    const index = rawTables.push(text.slice(start, end)) - 1;
    result += text.slice(cursor, start) + `${tokenPrefix}t${index}${TOKEN_END}`;
    cursor = end;
  }
  return result + text.slice(cursor);
}

function protectMSTeamsCode(
  ir: MarkdownIR,
  tokenPrefix: string,
  code: string[],
  protectedValues: readonly { prefix: string; values: readonly string[] }[],
): MarkdownIR {
  const codeSpans = ir.styles.filter(
    (span) => span.style === "code" || span.style === "code_block",
  );
  const codeBlocks = codeSpans.filter((span) => span.style === "code_block");
  const adjustedStyles = ir.styles.flatMap((span) => {
    if (span.style !== "blockquote") {
      return [span];
    }
    let segments = [span];
    for (const codeBlock of codeBlocks) {
      segments = segments.flatMap((segment) => {
        if (codeBlock.end <= segment.start || codeBlock.start >= segment.end) {
          return [segment];
        }
        return [
          ...(segment.start < codeBlock.start ? [{ ...segment, end: codeBlock.start }] : []),
          ...(codeBlock.end < segment.end ? [{ ...segment, start: codeBlock.end }] : []),
        ];
      });
    }
    return segments;
  });
  const rewritten = rewriteMarkdownIR(
    { ...ir, styles: adjustedStyles },
    codeSpans.map((span) => {
      const codeStyle = span.style === "code_block" ? "code_block" : "code";
      const source = protectedValues.reduce(
        (text, protectedValue) => restoreTokens(text, protectedValue.prefix, protectedValue.values),
        ir.text.slice(span.start, span.end),
      );
      const quoteDepth =
        codeStyle === "code_block"
          ? ir.styles.filter(
              (candidate) =>
                candidate.style === "blockquote" &&
                span.start >= candidate.start &&
                span.start < candidate.end,
            ).length
          : 0;
      const rendered = renderMSTeamsCode(codeStyle, source);
      let quoted =
        quoteDepth > 0
          ? `${"> ".repeat(quoteDepth)}${rendered.replaceAll("\n", `\n${"> ".repeat(quoteDepth)}`)}`
          : rendered;
      const hasTrailingQuotedText =
        codeStyle === "code_block" &&
        ir.styles.some(
          (candidate) =>
            candidate.style === "blockquote" &&
            span.start >= candidate.start &&
            candidate.end > span.end,
        );
      if (hasTrailingQuotedText && !quoted.endsWith("\n")) {
        quoted += "\n";
      }
      const index = code.push(quoted) - 1;
      return { start: span.start, end: span.end, text: `${tokenPrefix}c${index}${TOKEN_END}` };
    }),
  );
  return {
    ...rewritten,
    styles: rewritten.styles.filter((span) => span.style !== "code" && span.style !== "code_block"),
  };
}

export function formatMSTeamsMarkdown(markdown: string, tableMode: MarkdownTableMode): string {
  if (markdown === "") {
    return markdown;
  }
  const rawTables: string[] = [];
  const escapedMarkdown: string[] = [];
  const codeRegions: string[] = [];
  const images: string[] = [];
  const mentions: string[] = [];
  const entities: string[] = [];
  const tokenPrefix = createTokenPrefix(markdown, "msteamsformat");
  const entitiesProtected = markdown.replace(MARKDOWN_ENTITY_RE, (entity) => {
    const index = entities.push(entity) - 1;
    return `${tokenPrefix}h${index}${TOKEN_END}`;
  });
  const imagesProtected = protectDelimitedMarkdown(
    entitiesProtected,
    "![",
    `${tokenPrefix}i`,
    images,
  );
  const mentionsProtected = protectDelimitedMarkdown(
    imagesProtected,
    "@[",
    `${tokenPrefix}m`,
    mentions,
  );
  const tableInput = convertMarkdownTables(mentionsProtected, tableMode);
  const converted =
    tableMode === "off" ? protectRawTables(tableInput, tokenPrefix, rawTables) : tableInput;
  const protectedMarkdown = converted.replace(ESCAPED_MARKDOWN_RE, (escaped) => {
    const index = escapedMarkdown.push(escaped) - 1;
    return `${tokenPrefix}e${index}${TOKEN_END}`;
  });
  const parsed = markdownToIR(protectedMarkdown, {
    autolink: false,
    enableSpoilers: true,
    enableTaskLists: true,
    headingStyle: "rich",
    linkify: false,
    blockquotePrefix: "",
  });
  const ir = prefixMSTeamsBlockquotes(
    protectMSTeamsCode(parsed, tokenPrefix, codeRegions, [
      { prefix: `${tokenPrefix}e`, values: escapedMarkdown },
      { prefix: `${tokenPrefix}t`, values: rawTables },
      { prefix: `${tokenPrefix}m`, values: mentions },
      { prefix: `${tokenPrefix}i`, values: images },
      { prefix: `${tokenPrefix}h`, values: entities },
    ]),
  );
  const rendered = renderMarkdownWithMarkers(
    ir,
    {
      styleMarkers: MSTEAMS_MARKERS,
      escapeText: (text) => text,
      buildLink: (link) => ({
        start: link.start,
        end: link.end,
        open: "[",
        close: `](${serializeMarkdownDestination(link.href)})`,
      }),
    },
    MSTEAMS_FORMAT_CAPABILITIES,
  );
  let restored = restoreTokens(rendered, `${tokenPrefix}c`, codeRegions);
  restored = restoreTokens(restored, `${tokenPrefix}e`, escapedMarkdown);
  restored = restoreTokens(restored, `${tokenPrefix}t`, rawTables);
  restored = restoreTokens(restored, `${tokenPrefix}m`, mentions);
  restored = restoreTokens(restored, `${tokenPrefix}i`, images);
  return restoreTokens(restored, `${tokenPrefix}h`, entities);
}
