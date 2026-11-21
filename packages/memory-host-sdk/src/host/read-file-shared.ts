import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { MemoryReadResult } from "./types.js";

// Shared memory-file read result shaping and truncation notices.

/** Default number of lines returned by memory read helpers. */
const DEFAULT_MEMORY_READ_LINES = 120;
/** Default max character budget for memory read helper output. */
const DEFAULT_MEMORY_READ_MAX_CHARS = 12_000;

export type { LegacyMemoryReadResult, MemoryReadResult } from "./types.js";

function isMemoryThematicBreak(line: string): boolean {
  return /^ {0,3}(?:(?:\*[\t ]*){3,}|(?:_[\t ]*){3,}|(?:-[\t ]*){3,})$/u.test(line);
}

function parseMemoryContainerPrefix(line: string) {
  if (isMemoryThematicBreak(line)) {
    return undefined;
  }
  const match = /^( {0,3})(>|(?:[-+*]|\d{1,9}[.)])(?= |$))( *)/u.exec(line);
  if (!match) {
    return undefined;
  }
  const marker = match[2]!;
  const spaces = match[3]!.length;
  const list = marker !== ">";
  const empty = list && match[0].length === line.length;
  // Empty items and 5+ padding columns use one column; the latter leaves indented code.
  const padding = list ? (empty || spaces > 4 ? 1 : spaces) : Math.min(spaces, 1);
  return {
    list,
    length: match[1]!.length + marker.length + (empty ? spaces : padding),
    continuation: list ? ` {${match[1]!.length + marker.length + padding}}` : " {0,3}> ?",
    empty,
    interruptsParagraph:
      !list || (!empty && (!/^\d/u.test(marker) || Number.parseInt(marker, 10) === 1)),
  };
}

function expandMemoryMarkdownTabs(line: string): string {
  let extraColumns = 0;
  return line.replace(/\t/gu, (_tab, offset: number) => {
    const columns = 4 - ((offset + extraColumns) % 4);
    extraColumns += columns - 1;
    return " ".repeat(columns);
  });
}

const MEMORY_HTML_BLOCK_TAG =
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=\s|\/?>|$)/iu;

function isCompleteMemoryHtmlTag(source: string): boolean {
  const tag = /^<(\/?)[A-Za-z][A-Za-z0-9-]*([\s\S]*)$/u.exec(source);
  if (!tag) {
    return false;
  }
  let rest = tag[2]!;
  if (tag[1]) {
    return /^\s*>\s*$/u.test(rest);
  }
  while (!/^\s*\/?>\s*$/u.test(rest)) {
    const attribute =
      // oxlint-disable-next-line eslint/no-control-regex -- CommonMark excludes ASCII controls from unquoted attribute values.
      /^\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\x00-\x20"'=<>`]+))?/u.exec(
        rest,
      );
    if (!attribute) {
      return false;
    }
    rest = rest.slice(attribute[0].length);
  }
  return true;
}

/**
 * CommonMark block boundaries, not HTML sanitization: type 2 closes only at "-->", not "--!>".
 * https://spec.commonmark.org/0.31.2/#html-blocks
 */
function parseMemoryHtmlBlockStart(line: string) {
  const source = /^ {0,3}(<[\s\S]*)$/u.exec(line)?.[1];
  if (!source) {
    return undefined;
  }
  const end = /^<(?:script|pre|style|textarea)(?=\s|>|$)/iu.test(source)
    ? /<\/(?:script|pre|style|textarea)>/iu
    : source.startsWith("<!--")
      ? /-->/u
      : source.startsWith("<?")
        ? /\?>/u
        : /^<![A-Za-z]/u.test(source)
          ? />/u
          : source.startsWith("<![CDATA[")
            ? /\]\]>/u
            : undefined;
  if (end) {
    return { end, interruptsParagraph: true };
  }
  if (MEMORY_HTML_BLOCK_TAG.test(source)) {
    return { end: /^ *$/u, interruptsParagraph: true };
  }
  return isCompleteMemoryHtmlTag(source) ? { end: /^ *$/u, interruptsParagraph: false } : undefined;
}

/** Lazy container continuation is paragraph text, never a new block or a blank line. */
function canContinueMemoryParagraph(line: string): boolean {
  return (
    line.trim().length > 0 &&
    !/^ {0,3}#{1,6}(?:[\t ]|$)/u.test(line) &&
    !parseMemoryContainerPrefix(line)?.interruptsParagraph &&
    !parseMemoryHtmlBlockStart(line)?.interruptsParagraph &&
    !/^ {0,3}(?:`{3,}[^`]*|~{3,}.*)$/u.test(line) &&
    !isMemoryThematicBreak(line) &&
    !/^ {0,3}(?:=+|-+)[\t ]*$/u.test(line)
  );
}

/** Select a unique top-level ATX section, keeping its child headings and source offsets. */
function findMemoryHeadingRange(
  fileLines: string[],
  heading: string,
): { start: number; end: number } {
  const headings: Array<{ title: string; level: number; index: number }> = [];
  const containers: Array<{ prefix: RegExp; list: boolean }> = [];
  let paragraphOpen = false;
  let literalBlock: { end: RegExp; continuation: RegExp } | undefined;
  // Canonical frontmatter delimiters are column-zero "---" (with an optional opening BOM).
  // An unmatched opening rule is Markdown, not a frontmatter block extending to EOF.
  const frontmatterEnd = /^\uFEFF?---[^\S\n]*$/u.test(fileLines[0] ?? "")
    ? fileLines.findIndex((line, index) => index > 0 && /^---[^\S\n]*$/u.test(line))
    : -1;
  for (let index = frontmatterEnd + 1; index < fileLines.length; index += 1) {
    const rawLine = (fileLines[index] ?? "").replace(/\r$/u, "");
    const sourceLine = index === 0 ? rawLine.replace(/^\uFEFF/u, "") : rawLine;
    const line = expandMemoryMarkdownTabs(sourceLine);
    let fenceLine = line;
    let continuation = "";
    let continuedContainers = 0;
    for (const container of containers) {
      const prefix = container.prefix.exec(fenceLine);
      if (!prefix) {
        break;
      }
      fenceLine = fenceLine.slice(prefix[0].length);
      continuation += container.prefix.source.slice(1);
      continuedContainers += 1;
    }
    let followsParagraph: boolean = paragraphOpen && continuedContainers === containers.length;
    const nextContainer = parseMemoryContainerPrefix(fenceLine);
    // A sibling item ends the prior item even when its number cannot interrupt a paragraph.
    const siblingList =
      nextContainer?.list &&
      containers.some((container, position) => position >= continuedContainers && container.list);
    if (
      continuedContainers < containers.length &&
      paragraphOpen &&
      !nextContainer?.empty &&
      !siblingList &&
      canContinueMemoryParagraph(fenceLine)
    ) {
      continue;
    }
    // Blank lines retain container context, but end lazy paragraph continuation.
    paragraphOpen = false;
    if (line.trim()) {
      containers.length = continuedContainers;
    }
    if (literalBlock) {
      const prefix = literalBlock.continuation.exec(line);
      if (prefix || !line.trim()) {
        if (literalBlock.end.test(line.slice(prefix?.[0].length ?? 0))) {
          literalBlock = undefined;
        }
        continue;
      }
      // Literal blocks inside a list/quote also end when their enclosing container ends.
      literalBlock = undefined;
    }
    // Thematic breaks take precedence over list markers, including after a container prefix.
    // List markers become indentation on later lines.
    for (
      let container = parseMemoryContainerPrefix(fenceLine);
      container && (!followsParagraph || container.interruptsParagraph);
      container = parseMemoryContainerPrefix(fenceLine)
    ) {
      containers.push({
        prefix: new RegExp(`^${container.continuation}`, "u"),
        list: container.list,
      });
      continuation += container.continuation;
      fenceLine = fenceLine.slice(container.length);
      followsParagraph = false;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(fenceLine);
    if (fenceMatch && !(fenceMatch[1]![0] === "`" && fenceMatch[2]?.includes("`"))) {
      literalBlock = {
        end: new RegExp(`^ {0,3}${fenceMatch[1]![0]}{${fenceMatch[1]!.length},} *$`, "u"),
        continuation: new RegExp(`^${continuation}`, "u"),
      };
      continue;
    }
    const html = parseMemoryHtmlBlockStart(fenceLine);
    if (html && (!followsParagraph || html.interruptsParagraph)) {
      if (!html.end.test(fenceLine)) {
        literalBlock = { end: html.end, continuation: new RegExp(`^${continuation}`, "u") };
      }
      continue;
    }
    paragraphOpen =
      canContinueMemoryParagraph(fenceLine) &&
      (followsParagraph || !/^(?: {4}|\t)/u.test(fenceLine));
    if (containers.length > 0) {
      continue;
    }
    const match = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|[\t ]*)$/u.exec(sourceLine);
    if (match) {
      headings.push({
        title: (match[2] ?? "").replace(/[\t ]+#+[\t ]*$/u, "").trim(),
        level: match[1]!.length,
        index,
      });
    }
  }
  const matches = headings.filter((item) => item.title === heading);
  if (matches.length !== 1) {
    throw Object.assign(
      new Error(
        matches.length === 0
          ? "No matching ATX heading. Use from/lines to read by source line instead."
          : `Heading is ambiguous (lines ${matches
              .slice(0, 8)
              .map((item) => item.index + 1)
              .join(", ")}). Omit heading and use from/lines to select the intended section.`,
      ),
      { code: matches.length === 0 ? "MEMORY_HEADING_NOT_FOUND" : "MEMORY_HEADING_AMBIGUOUS" },
    );
  }
  const selected = matches[0]!;
  return {
    start: selected.index + 1,
    end:
      headings.find((item) => item.index > selected.index && item.level <= selected.level)?.index ??
      fileLines.length,
  };
}

/** Build the continuation notice appended to truncated memory excerpts. */
function buildContinuationNotice(params: {
  nextFrom: number | undefined;
  suggestReadFallback?: boolean;
}): string {
  const base =
    typeof params.nextFrom === "number"
      ? `[More content available. Use from=${params.nextFrom} to continue.]`
      : "[More content available. Requested excerpt exceeded the default maxChars budget.]";
  const fallback = params.suggestReadFallback
    ? " If you need the full raw line, use read on the source file."
    : "";
  return `\n\n${base.slice(0, -1)}${fallback}]`;
}

/** Fit line slices to the response character budget while preserving line boundaries. */
function fitLinesToCharBudget(params: { lines: string[]; maxChars: number }): {
  text: string;
  includedLines: number;
  hardTruncatedSingleLine: boolean;
} {
  const { lines, maxChars } = params;
  let includedLines = 0;
  let chars = 0;
  for (const line of lines) {
    const nextChars = chars + line.length + (includedLines > 0 ? 1 : 0);
    // Keep an oversized first line for the existing single-line truncation contract.
    if (includedLines > 0 && nextChars > maxChars) {
      break;
    }
    includedLines += 1;
    chars = nextChars;
  }

  return {
    text: truncateUtf16Safe(lines.slice(0, includedLines).join("\n"), maxChars),
    includedLines,
    hardTruncatedSingleLine: chars > maxChars,
  };
}

/** Build a memory read result from an already-selected line slice. */
export function buildMemoryReadResultFromSlice(params: {
  selectedLines: string[];
  relPath: string;
  startLine: number;
  moreSourceLinesRemain?: boolean;
  maxChars?: number;
  suggestReadFallback?: boolean;
}): MemoryReadResult {
  const start = resolveIntegerOption(params.startLine, 1, { min: 1 });
  const fitted = fitLinesToCharBudget({
    lines: params.selectedLines,
    maxChars: resolveIntegerOption(params.maxChars, DEFAULT_MEMORY_READ_MAX_CHARS, { min: 1 }),
  });
  const moreSourceLinesRemain = params.moreSourceLinesRemain ?? false;
  const charCapTruncated =
    fitted.hardTruncatedSingleLine || fitted.includedLines < params.selectedLines.length;
  const nextFrom =
    !fitted.hardTruncatedSingleLine &&
    (moreSourceLinesRemain || fitted.includedLines < params.selectedLines.length)
      ? start + fitted.includedLines
      : undefined;
  const truncated = charCapTruncated || moreSourceLinesRemain;
  const text =
    truncated && (fitted.text || fitted.hardTruncatedSingleLine)
      ? `${fitted.text}${buildContinuationNotice({
          nextFrom,
          suggestReadFallback: fitted.hardTruncatedSingleLine && params.suggestReadFallback,
        })}`
      : fitted.text;
  return {
    status: "ok",
    text,
    path: params.relPath,
    from: start,
    lines: fitted.includedLines,
    ...(truncated ? { truncated: true } : {}),
    ...(typeof nextFrom === "number" ? { nextFrom } : {}),
  };
}

/** Build a memory read result from raw file content and caller range options. */
export function buildMemoryReadResult(params: {
  content: string;
  relPath: string;
  from?: number;
  lines?: number;
  heading?: string;
  defaultLines?: number;
  maxChars?: number;
  suggestReadFallback?: boolean;
}): MemoryReadResult {
  const fileLines = params.content.split("\n");
  // A terminal newline closes the preceding line; its split sentinel is not a
  // readable blank line or a reason to offer another memory page.
  if (fileLines.at(-1) === "") {
    fileLines.pop();
  }
  const section = params.heading ? findMemoryHeadingRange(fileLines, params.heading) : undefined;
  const start = resolveIntegerOption(params.from, section?.start ?? 1, { min: 1 });
  if (section && (start < section.start || start > section.end)) {
    throw Object.assign(new Error("from must be within the selected heading section."), {
      code: "MEMORY_HEADING_RANGE_INVALID",
    });
  }
  const requestedCount = resolveIntegerOption(
    params.lines ?? params.defaultLines,
    DEFAULT_MEMORY_READ_LINES,
    { min: 1 },
  );
  const end = section?.end ?? fileLines.length;
  const selectedLines = fileLines.slice(start - 1, Math.min(end, start - 1 + requestedCount));
  const moreSourceLinesRemain = start - 1 + selectedLines.length < end;
  return buildMemoryReadResultFromSlice({
    selectedLines,
    relPath: params.relPath,
    startLine: start,
    moreSourceLinesRemain,
    maxChars: params.maxChars,
    suggestReadFallback: params.suggestReadFallback,
  });
}
