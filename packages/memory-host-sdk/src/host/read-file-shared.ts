import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { MemoryReadResult } from "./types.js";

// Shared memory-file read result shaping and truncation notices.

/** Default number of lines returned by memory read helpers. */
const DEFAULT_MEMORY_READ_LINES = 120;
/** Default max character budget for memory read helper output. */
const DEFAULT_MEMORY_READ_MAX_CHARS = 12_000;

export type { LegacyMemoryReadResult, MemoryReadResult } from "./types.js";

/** Select a unique top-level ATX section, keeping its child headings and source offsets. */
function findMemoryHeadingRange(
  fileLines: string[],
  heading: string,
): { start: number; end: number } {
  const headings: Array<{ title: string; level: number; index: number }> = [];
  let fence: { marker: string; length: number } | undefined;
  let frontmatter = fileLines[0]?.trim() === "---";
  for (let index = 0; index < fileLines.length; index += 1) {
    const line = (fileLines[index] ?? "").replace(/\r$/u, "");
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/u.test(line)) {
        frontmatter = false;
      }
      continue;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (
        fenceMatch?.[1]?.[0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        !fenceMatch[2]?.trim()
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch && !(fenceMatch[1]![0] === "`" && fenceMatch[2]?.includes("`"))) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    const match = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|[\t ]*)$/u.exec(line);
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
