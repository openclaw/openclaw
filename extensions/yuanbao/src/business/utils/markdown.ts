/**
 * Markdown processing utilities.
 *
 * Provides fence detection/repair, block-level structure analysis, and atomic-block-aware chunking.
 * Divided into three namespaces:
 *  - mdFence  — fence detection & repair
 *  - mdBlock  — block-level structure detection & separator inference
 *  - mdAtomic — atomic block (table & diagram fence) extraction & aware chunking
 */

// ============================================================================
// Fence-related
// ============================================================================

/**
 * Strip outer ```markdown fences wrapping AI replies.
 *
 * Some models wrap table-containing replies in ```markdown fences, causing clients to render tables as code blocks.
 * Only strips when the interior contains a table to avoid damaging real code blocks.
 */
function stripOuterMarkdownFence(text: string): string {
  const HAS_TABLE = /^\s*\|[-:| ]+\|/m;
  return text.replace(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/gm, (fullMatch, inner: string) =>
    HAS_TABLE.test(inner) ? inner : fullMatch,
  );
}

/**
 * Check if text is inside an unclosed code fence (``` block).
 *
 * Scans line by line, toggling state on lines starting with ```. Odd toggles indicate an unclosed fence.
 */
function hasUnclosedFence(text: string): boolean {
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
    }
  }
  return inFence;
}

/**
 * Check if text is inside an unclosed math block (`$$...$$`).
 *
 * Scans line by line, skipping content inside code fences, counting `$$` occurrences.
 * An odd count indicates an unclosed math block.
 */
function hasUnclosedMathBlock(text: string): boolean {
  let inFence = false;
  let mathOpen = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    let idx = 0;
    while (idx < line.length - 1) {
      if (line[idx] === "$" && line[idx + 1] === "$") {
        mathOpen = !mathOpen;
        idx += 2;
      } else {
        idx++;
      }
    }
  }
  return mathOpen;
}

/**
 * Fix paragraph separators erroneously inserted by block-streaming inside math blocks.
 *
 * Replaces consecutive blank lines (`\n\n+`) inside `$$...$$` with a single `\n`.
 * Only processes `$$` blocks outside code fences.
 */
function normalizeMathBlocks(text: string): string {
  if (!text.includes("$$")) {
    return text;
  }

  const parts: string[] = [];
  let inFence = false;
  let mathOpen = false;
  let segStart = 0;

  for (let i = 0; i < text.length; i++) {
    if ((i === 0 || text[i - 1] === "\n") && text.startsWith("```", i)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    if (text[i] === "$" && i + 1 < text.length && text[i + 1] === "$") {
      if (!mathOpen) {
        mathOpen = true;
        parts.push(text.slice(segStart, i + 2));
        segStart = i + 2;
        i++;
      } else {
        const mathContent = text.slice(segStart, i);
        parts.push(mathContent.replace(/\n\n+/g, "\n"));
        parts.push("$$");
        segStart = i + 2;
        mathOpen = false;
        i++;
      }
    }
  }

  if (segStart < text.length) {
    const remaining = text.slice(segStart);
    parts.push(mathOpen ? remaining.replace(/\n\n+/g, "\n") : remaining);
  }

  return parts.join("");
}

/**
 * Append incoming to buffer, stripping redundant fence repair markers from block-streaming.
 *
 * Handles three error patterns:
 * 1. Internal pseudo-lines: close+open markers fused into a 6-backtick line -> replaced with `\n`.
 * 2. Boundary A: buffer ends with close marker, incoming starts with open marker -> both stripped.
 * 3. Boundary B: buffer has unclosed fence, incoming brings re-open marker -> strip re-open only.
 */
function mergeBlockStreamingFences(buffer: string, incoming: string): string {
  const CLOSE_RE = /\n```\s*$/;
  const OPEN_RE = /^```[^\n]*\n/;

  // Case 1: eliminate internal pseudo-lines (\n``````lang\n)
  const normalized = incoming.replace(/\n```\s*```[^\n]*\n/g, "\n");

  // Case 2: buffer ends with close marker, incoming starts with re-open marker
  if (CLOSE_RE.test(buffer) && OPEN_RE.test(normalized)) {
    return `${buffer.replace(CLOSE_RE, "")}\n${normalized.replace(OPEN_RE, "")}`;
  }

  // Case 3: buffer has unclosed fence, incoming brings re-open marker -> strip it
  if (hasUnclosedFence(buffer) && OPEN_RE.test(normalized)) {
    return `${buffer}\n${normalized.replace(OPEN_RE, "")}`;
  }

  return `${buffer}${normalized}`;
}

// ============================================================================
// Block-level structure
// ============================================================================

/**
 * Check if the last non-empty line is a Markdown table row (starts and ends with |).
 *
 * Used to determine if the buffer ends with a table row — if so, wait for the next deliver block
 * to avoid splitting in the middle of a table.
 */
function endsWithTableRow(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return false;
  }
  const lastLine = trimmed.split("\n").at(-1) ?? "";
  const line = lastLine.trim();
  return line.startsWith("|") && line.endsWith("|");
}

/**
 * Check if text starts with a Markdown block-level element.
 *
 * Used during block-streaming merge to infer whether a paragraph separator (`\n\n`) is needed.
 */
function startsWithBlockElement(text: string): boolean {
  const firstLine = (text.trimStart().split("\n")[0] ?? "").trimStart();
  return (
    /^#{1,6}\s/.test(firstLine) || // heading
    firstLine.startsWith("---") || // thematic break
    firstLine.startsWith("***") ||
    firstLine.startsWith("___") ||
    firstLine.startsWith("> ") || // blockquote
    firstLine.startsWith("```") || // fenced code block
    /^[*\-+]\s/.test(firstLine) || // unordered list
    /^\d+[.)]\s/.test(firstLine) || // ordered list
    firstLine.startsWith("|") || // table
    firstLine.startsWith("$$")
  ); // display math
}

/**
 * Infer the separator to insert between buffer and incoming blocks.
 *
 * Block-streaming trims each block, discarding `\n\n` at paragraph boundaries.
 * This function heuristically restores the correct separator.
 *
 * Priority (high to low):
 *  1. Inside fence / already has `\n\n` -> no separator
 *  2. Mid-row table split -> `' '` (rejoin same line)
 *  3. Consecutive table rows -> `'\n'`
 *  4. Incoming starts with block element -> `'\n\n'`
 *  5. Otherwise -> no separator
 */
function inferBlockSeparator(buffer: string, incoming: string): string {
  if (hasUnclosedFence(buffer)) {
    return "";
  }
  if (hasUnclosedMathBlock(buffer)) {
    return "";
  }
  if (buffer.endsWith("\n\n")) {
    return "";
  }

  const lastLine = (buffer.trimEnd().split("\n").at(-1) ?? "").trim();
  const firstLine = (incoming.trimStart().split("\n")[0] ?? "").trimStart();

  // OpenClaw may split a table row at maxChars, producing two blocks:
  //   buffer last line: "| GPT-4o | 88.7% | 90.2% | - |"
  //   incoming:         "- |\n| Claude 3.5 ..."
  // Detect: buffer last line is a table row, incoming first line ends with | but doesn't start with |
  if (lastLine.startsWith("|") && !firstLine.startsWith("|") && firstLine.endsWith("|")) {
    return " ";
  }

  if (lastLine.startsWith("|") && firstLine.startsWith("|")) {
    return "\n";
  }

  if (startsWithBlockElement(incoming)) {
    return "\n\n";
  }

  return "";
}

// ============================================================================
// Pipe-table sanitize
// ============================================================================

/**
 * Markdown pipe-table sanitizer.
 *
 * Block-streaming may insert `\n\n` (or `\n`) at arbitrary positions within pipe tables,
 * breaking GFM rendering.
 *
 * Strategy:
 *   Phase 0: Fast-path exit when text clearly contains no tables.
 *   Phase 1: Scan lines, group consecutive pipe-containing lines as candidate table regions.
 *   Phase 2: For regions with blank lines and a GFM separator row, remove blanks and merge
 *            fragment lines based on structural signals (whether lines start/end with `|`).
 *   Phase 3: Reassemble repaired regions back into the original text.
 */

interface PipeTableRegion {
  /** Start line index (inclusive) */
  startLine: number;
  /** End line index (inclusive) */
  endLine: number;
}

/**
 * Scan raw lines, grouping consecutive pipe-containing lines as candidate table regions.
 * Blank lines between pipe lines are kept in the same group (they are `\n\n` artifacts to fix).
 * Non-empty lines without pipe characters end the current group.
 */
function findPipeTableRegions(lines: string[]): PipeTableRegion[] {
  const regions: PipeTableRegion[] = [];
  let groupStart = -1;
  let lastPipeLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasPipe = line.includes("|");
    const isBlank = line.trim() === "";

    if (hasPipe) {
      if (groupStart < 0) {
        groupStart = i;
      }
      lastPipeLine = i;
    } else if (isBlank) {
      // Blank line — keep in current group if one exists
    } else {
      // Non-empty without pipe -> close current group
      if (groupStart >= 0) {
        regions.push({ startLine: groupStart, endLine: lastPipeLine });
        groupStart = -1;
        lastPipeLine = -1;
      }
    }
  }

  if (groupStart >= 0) {
    regions.push({ startLine: groupStart, endLine: lastPipeLine });
  }

  return regions;
}

/** GFM separator row regex: optional colon + 2+ dashes + optional colon, between two `|` */
const PIPE_TABLE_SEPARATOR_RE = /\|[\s]*:?-{2,}:?[\s]*(?:\|[\s]*:?-{2,}:?[\s]*)+\|/;

function findSeparatorInFlat(flat: string): boolean {
  return PIPE_TABLE_SEPARATOR_RE.test(flat);
}

/**
 * Fix a table region: remove blank lines and merge fragment lines.
 *
 * Rule: if accumulated line ends with `|` and next line starts with `|`, they are separate rows;
 * otherwise the next line is a continuation fragment.
 */
function healPipeTableRegion(regionLines: string[]): string | null {
  if (!regionLines.some((l) => l.trim() === "")) {
    return null;
  }

  const flat = regionLines.join("").replace(/\n/g, "");
  if (!findSeparatorInFlat(flat)) {
    return null;
  }

  const nonBlank = regionLines.filter((l) => l.trim() !== "");
  const result: string[] = [];
  let acc = "";

  for (const line of nonBlank) {
    if (!acc) {
      acc = line;
    } else if (acc.trimEnd().endsWith("|") && line.trimStart().startsWith("|")) {
      result.push(acc);
      acc = line;
    } else {
      acc += line;
    }
  }

  if (acc) {
    result.push(acc);
  }

  return result.join("\n");
}

/**
 * Fix Markdown pipe tables broken by block-streaming `\n\n` insertion.
 *
 * Identifies table regions, verifies GFM separator presence, removes blank lines,
 * and re-merges fragment lines using structural signals (`|` at line start/end).
 * Safe to call on any text — non-table content passes through unchanged.
 */
function sanitizePipeTables(text: string): string {
  // Phase 0 — fast-path exit
  if (!text) {
    return text;
  }
  if (!text.includes("|")) {
    return text;
  }
  if (!text.includes("\n")) {
    return text;
  }

  const pipeCount = (text.match(/\|/g) || []).length;
  if (pipeCount < 3) {
    return text;
  }

  // Phase 1 — find table regions
  const lines = text.split("\n");
  const regions = findPipeTableRegions(lines);

  if (regions.length === 0) {
    return text;
  }

  // Phase 2+3 — heal regions and rebuild (reverse order to keep indices stable)
  for (let ri = regions.length - 1; ri >= 0; ri--) {
    const region = regions[ri];
    const regionLines = lines.slice(region.startLine, region.endLine + 1);
    const healed = healPipeTableRegion(regionLines);
    if (healed !== null) {
      const healedLines = healed.split("\n");
      lines.splice(region.startLine, region.endLine - region.startLine + 1, ...healedLines);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// Atomic blocks — tables & diagram fence blocks
// ============================================================================

/** Markdown structures that cannot render independently after splitting */
export type AtomicBlock = { start: number; end: number; kind: "table" | "diagram-fence" };

/** Diagram fence language identifiers — these fence blocks cannot render after splitting */
const DIAGRAM_LANGUAGES = new Set([
  "mermaid",
  "plantuml",
  "sequence",
  "flowchart",
  "gantt",
  "classdiagram",
  "statediagram",
  "erdiagram",
  "journey",
  "gitgraph",
  "mindmap",
  "timeline",
]);

/**
 * Extract all atomic blocks (tables and diagram fence blocks) with character offset ranges.
 *
 * Line-by-line scan:
 * - Skips content inside plain code fences to avoid misidentifying `|` as table rows.
 * - Marks complete fence blocks with diagram languages as `diagram-fence` atomic blocks.
 * - Marks consecutive `|`-prefixed lines (with separator on 2nd line) as `table` atomic blocks.
 */
function extractAtomicBlocks(text: string): AtomicBlock[] {
  const blocks: AtomicBlock[] = [];
  const lines = text.split("\n");
  let offset = 0;

  let inPlainFence = false; // Currently inside a plain code fence
  let inDiagram = false; // Currently inside a diagram fence
  let diagramStart = 0; // Start offset of current diagram fence

  let tableStart = -1; // Start offset of current table block, -1 = not in table
  let tableEnd = -1; // End offset of last table line
  let tableHasSep = false; // Whether separator row has been seen
  let tableLineCount = 0; // Consecutive table line count

  const isTableLine = (line: string) => line.trim().startsWith("|");
  const isTableSeparator = (line: string) => /^\|[\s|:-]+\|$/.test(line.trim());

  const flushTable = () => {
    // A complete table (with separator) or >= 2 consecutive |-prefixed lines are treated as atomic,
    // preventing chunkMarkdownText from splitting between incomplete table rows.
    if (tableStart !== -1 && tableEnd !== -1 && (tableHasSep || tableLineCount >= 2)) {
      blocks.push({ start: tableStart, end: tableEnd, kind: "table" });
    }
    tableStart = -1;
    tableEnd = -1;
    tableHasSep = false;
    tableLineCount = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Last line: if no trailing \n, calculate offset by actual length
    const lineEnd = offset + line.length + (i < lines.length - 1 ? 1 : 0);

    if (inPlainFence || inDiagram) {
      if (line.startsWith("```")) {
        if (inDiagram) {
          blocks.push({ start: diagramStart, end: lineEnd, kind: "diagram-fence" });
          inDiagram = false;
        } else {
          inPlainFence = false;
        }
      }
      offset = lineEnd;
      continue;
    }

    if (line.startsWith("```")) {
      flushTable();
      const lang = line.slice(3).trim().toLowerCase();
      if (lang && DIAGRAM_LANGUAGES.has(lang)) {
        inDiagram = true;
        diagramStart = offset;
      } else {
        inPlainFence = true;
      }
      offset = lineEnd;
      continue;
    }

    if (isTableLine(line)) {
      if (tableStart === -1) {
        tableStart = offset;
        tableLineCount = 1;
        tableHasSep = false;
      } else {
        tableLineCount++;
        if (!tableHasSep && tableLineCount === 2 && isTableSeparator(line)) {
          tableHasSep = true;
        }
      }
      tableEnd = lineEnd;
    } else {
      flushTable();
    }

    offset = lineEnd;
  }

  flushTable();
  return blocks.toSorted((a, b) => a.start - b.start);
}

/**
 * Atomic-block-aware Markdown text chunking.
 *
 * Runs `chunkFn` for fence-aware rough chunking, then checks if split boundaries fall inside
 * atomic blocks (tables / diagram fences):
 * - If inside, shift boundary before `block.start` (push entire block to next message).
 * - If cannot shift back (block at chunk start), shift after `block.end` (include in current chunk).
 * - If entire text is a single oversized atomic block, return `[text]` (graceful degradation).
 */
function chunkMarkdownTextAtomicAware(
  text: string,
  maxChars: number,
  chunkFn: (text: string, max: number) => string[],
): string[] {
  const rawChunks = chunkFn(text, maxChars);
  if (rawChunks.length <= 1) {
    return rawChunks;
  }

  const atomicBlocks = extractAtomicBlocks(text);
  if (atomicBlocks.length === 0) {
    return rawChunks;
  }

  // Rebuild split boundaries from rawChunks (cumulative offset, excluding last)
  const splitIndices: number[] = [];
  let cumLen = 0;
  for (let i = 0; i < rawChunks.length - 1; i++) {
    cumLen += rawChunks[i].length;
    splitIndices.push(cumLen);
  }

  // Adjust each split point to avoid landing inside an atomic block
  const adjustedIndices: number[] = [];
  let chunkWindowStart = 0;

  for (const idx of splitIndices) {
    const hit = atomicBlocks.find((b) => b.start < idx && idx < b.end);
    if (!hit) {
      adjustedIndices.push(idx);
      chunkWindowStart = idx;
      continue;
    }

    if (hit.start > chunkWindowStart) {
      // Shift back: push entire block to next message
      adjustedIndices.push(hit.start);
      chunkWindowStart = hit.start;
    } else {
      // Cannot shift back: include entire block in current message (allow exceeding maxChars)
      adjustedIndices.push(hit.end);
      chunkWindowStart = hit.end;
    }
  }

  // Re-slice text at adjusted boundaries
  const result: string[] = [];
  let prev = 0;
  for (const idx of adjustedIndices) {
    if (idx > prev) {
      result.push(text.slice(prev, idx));
    }
    prev = idx;
  }
  if (prev < text.length) {
    result.push(text.slice(prev));
  }

  return result.filter((c) => c.length > 0);
}

// ============================================================================
// Structured namespace exports
// ============================================================================

/** Fence detection & repair */
export const mdFence = {
  /** Strip outer ```markdown fence */
  stripOuter: stripOuterMarkdownFence,
  /** Check for unclosed code fence */
  hasUnclosed: hasUnclosedFence,
  /** Check for unclosed math block */
  hasUnclosedMath: hasUnclosedMathBlock,
  /** Merge redundant block-streaming fence markers */
  mergeBlockStreaming: mergeBlockStreamingFences,
} as const;

/** Block-level structure detection & separator inference */
export const mdBlock = {
  /** Check if text starts with a block-level element */
  startsWithBlockElement,
  /** Check if text ends with a table row */
  endsWithTableRow,
  /** Infer separator between two block-streaming blocks */
  inferSeparator: inferBlockSeparator,
} as const;

/** Atomic block (table & diagram fence) aware chunking */
export const mdAtomic = {
  /** Extract all atomic block offset ranges from text */
  extract: extractAtomicBlocks,
  /** Atomic-block-aware text chunking */
  chunkAware: chunkMarkdownTextAtomicAware,
  /** Diagram fence language identifiers */
  DIAGRAM_LANGUAGES,
} as const;

/** Pipe-table repair */
export const mdTable = {
  /** Fix pipe tables broken by block-streaming */
  sanitize: sanitizePipeTables,
} as const;

/** Math block repair */
export const mdMath = {
  /** Check for unclosed math block */
  hasUnclosed: hasUnclosedMathBlock,
  /** Fix paragraph separators erroneously inserted inside math blocks */
  normalize: normalizeMathBlocks,
} as const;
