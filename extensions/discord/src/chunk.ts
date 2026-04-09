import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";

const BQ_PREFIX_RE = /^(>+\s?)/;
const TABLE_SEPARATOR_RE = /^\|?[\s-:|]+\|[\s-:|]*$/;

// Inline formatting markers, longest first.
const INLINE_MARKERS = ["***", "**", "*", "___", "__", "_", "``", "`"];

type InlineFormatState = {
  openMarkers: string[];
};

/**
 * Scan text for unmatched inline formatting markers, skipping fenced regions.
 */
function scanUnmatchedInlineMarkers(text: string): InlineFormatState {
  const openMarkers: string[] = [];
  let i = 0;
  let inFence = false;

  while (i < text.length) {
    // Simple fence detection: toggle on ``` at start of line
    if ((i === 0 || text[i - 1] === "\n") && text.startsWith("```", i)) {
      inFence = !inFence;
      i += 3;
      // Skip to end of line
      while (i < text.length && text[i] !== "\n") { i++; }
      continue;
    }
    if (inFence) { i++; continue; }

    // Skip escaped characters
    if (text[i] === "\\" && i + 1 < text.length) { i += 2; continue; }

    // Try to match markers longest-first
    let matched = false;
    for (const marker of INLINE_MARKERS) {
      if (text.startsWith(marker, i)) {
        // For _-based markers: only treat as emphasis at word boundaries
        if (marker.startsWith("_")) {
          const prev = i > 0 ? text[i - 1] : " ";
          const next = i + marker.length < text.length ? text[i + marker.length] : " ";
          if (/\w/.test(prev) || /\w/.test(next)) { i++; matched = true; break; }
        }
        const existingIdx = openMarkers.lastIndexOf(marker);
        if (existingIdx !== -1) {
          openMarkers.splice(existingIdx, 1);
        } else {
          openMarkers.push(marker);
        }
        i += marker.length;
        matched = true;
        break;
      }
    }
    if (!matched) { i++; }
  }

  return { openMarkers };
}

type TableHeader = {
  headerLine: string;
  separatorLine: string;
};

export type ChunkDiscordTextOpts = {
  /** Max characters per Discord message. Default: 2000. */
  maxChars?: number;
  /**
   * Soft max line count per message. Default: 17.
   *
   * Discord clients can clip/collapse very tall messages in the UI; splitting
   * by lines keeps long multi-paragraph replies readable.
   */
  maxLines?: number;
};

type OpenFence = {
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
};

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_LINES = 17;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function countLines(text: string) {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

function parseFenceLine(line: string): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) {
    return null;
  }
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  return {
    indent,
    markerChar: marker[0] ?? "`",
    markerLen: marker.length,
    openLine: line,
  };
}

function closeFenceLine(openFence: OpenFence) {
  return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}

function closeFenceIfNeeded(text: string, openFence: OpenFence | null) {
  if (!openFence) {
    return text;
  }
  const closeLine = closeFenceLine(openFence);
  if (!text) {
    return closeLine;
  }
  if (!text.endsWith("\n")) {
    return `${text}\n${closeLine}`;
  }
  return `${text}${closeLine}`;
}

function splitLongLine(
  line: string,
  maxChars: number,
  opts: { preserveWhitespace: boolean },
): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  if (line.length <= limit) {
    return [line];
  }
  const out: string[] = [];
  let remaining = line;
  while (remaining.length > limit) {
    if (opts.preserveWhitespace) {
      out.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
      continue;
    }
    const window = remaining.slice(0, limit);
    let breakIdx = -1;
    for (let i = window.length - 1; i >= 0; i--) {
      if (/\s/.test(window[i])) {
        breakIdx = i;
        break;
      }
    }
    if (breakIdx <= 0) {
      breakIdx = limit;
    }
    out.push(remaining.slice(0, breakIdx));
    // Keep the separator for the next segment so words don't get glued together.
    remaining = remaining.slice(breakIdx);
  }
  if (remaining.length) {
    out.push(remaining);
  }
  return out;
}

/**
 * Discord renders `> ` blockquote bars only for each physical line.
 * A long `> ...` paragraph that wraps visually will lose the bar after
 * the first visual line break.  Pre-split long blockquote lines at
 * word boundaries so every rendered line gets its own `> ` prefix.
 *
 * Target ~80 chars per physical line to stay well within typical desktop
 * and mobile column widths while keeping the content readable.
 */
const BQ_LINE_TARGET = 90;

function presplitBlockquoteLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let insideFence = false;

  for (const line of lines) {
    // Don't touch lines inside code fences
    if (FENCE_RE.test(line)) {
      insideFence = !insideFence;
      out.push(line);
      continue;
    }
    if (insideFence) {
      out.push(line);
      continue;
    }

    const bqMatch = line.match(BQ_PREFIX_RE);
    if (!bqMatch || line.length <= BQ_LINE_TARGET) {
      out.push(line);
      continue;
    }

    const prefix = bqMatch[1]; // e.g. "> " or ">> "
    const content = line.slice(prefix.length);
    // Split on whitespace boundaries, keeping words intact.
    const words = content.split(" ");
    let cur = prefix;

    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi];
      if (!word) {
        continue;
      } // skip empty from consecutive spaces
      const sep = cur.length > prefix.length ? " " : "";
      if (
        cur.length + sep.length + word.length > BQ_LINE_TARGET &&
        cur.length > prefix.length
      ) {
        // Don't break if this word would start the new line looking like a
        // Discord list marker (e.g. "> - we" renders as a bullet item).
        if (/^[-*+]/.test(word)) {
          cur += `${sep}${word}`;
          continue;
        }
        out.push(cur);
        cur = `${prefix}${word}`;
      } else {
        cur += `${sep}${word}`;
      }
    }
    if (cur.length > prefix.length) {
      out.push(cur);
    }
  }

  return out.join("\n");
}

/**
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
export function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));

  const raw = text ?? "";
  if (!raw) {
    return [];
  }

  // Pre-split long blockquote lines so Discord renders the quote bar on
  // every physical line instead of losing it after the first wrap.
  const body = presplitBlockquoteLines(raw);

  const alreadyOk = body.length <= maxChars && countLines(body) <= maxLines;
  if (alreadyOk) {
    return [body];
  }

  const lines = body.split("\n");
  const chunks: string[] = [];

  let current = "";
  let currentLines = 0;
  let openFence: OpenFence | null = null;
  let insideBlockquote: string | null = null; // the `> ` prefix
  let openTable: TableHeader | null = null;
  let pendingTableHeader = false; // true when next line might be a separator
  let lastLineWasTableCandidate = ""; // stash the potential header line

  // Track table headers inside code fences so we can repeat them when
  // a code-fenced table is split across chunks.
  let fenceTableHeader: TableHeader | null = null;
  let fencePendingTableHeader = false;
  let fenceLastTableCandidate = "";
  let fenceLinesAfterOpen = 0; // how many content lines seen since fence opened

  const flush = () => {
    if (!current) {
      return;
    }
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) {
      chunks.push(payload);
    }
    current = "";
    currentLines = 0;
    // Reopen fence context
    if (openFence) {
      current = openFence.openLine;
      currentLines = 1;
      // If we detected a table header inside this code fence, repeat it
      if (fenceTableHeader) {
        current += `\n${fenceTableHeader.headerLine}\n${fenceTableHeader.separatorLine}`;
        currentLines += 2;
      } else if (fencePendingTableHeader && fenceLastTableCandidate) {
        // Header candidate seen but separator hasn't landed yet;
        // repeat the candidate so the separator appears in the same chunk.
        current += `\n${fenceLastTableCandidate}`;
        currentLines += 1;
      }
    }
    // Reopen table context: repeat header + separator
    if (openTable && !openFence) {
      const tableReopen = `${openTable.headerLine}\n${openTable.separatorLine}`;
      if (current) {
        current += `\n${tableReopen}`;
        currentLines += 2;
      } else {
        current = tableReopen;
        currentLines = 2;
      }
    }
    // Pending table header: separator hasn't landed yet, repeat the candidate header
    // so the separator that follows appears in the same chunk as its header.
    if (pendingTableHeader && lastLineWasTableCandidate && !openFence && !openTable) {
      if (current) {
        current += `\n${lastLineWasTableCandidate}`;
        currentLines += 1;
      } else {
        current = lastLineWasTableCandidate;
        currentLines = 1;
      }
    }
  };

  // Helper: apply blockquote prefix to a line if we're inside a blockquote
  const applyBlockquoteToSegment = (segment: string, prefix: string | null): string => {
    if (!prefix) {
      return segment;
    }
    if (segment.trim() === "") {
      return segment;
    }
    if (segment.startsWith(prefix.trimEnd())) {
      return segment;
    }
    return `${prefix}${segment}`;
  };

  for (const originalLine of lines) {
    const fenceInfo = parseFenceLine(originalLine);
    const wasInsideFence = openFence !== null;
    let nextOpenFence: OpenFence | null = openFence;
    if (fenceInfo) {
      if (!openFence) {
        nextOpenFence = fenceInfo;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen
      ) {
        nextOpenFence = null;
      }
    }

    const reserveChars = nextOpenFence ? closeFenceLine(nextOpenFence).length + 1 : 0;
    const reserveLines = nextOpenFence ? 1 : 0;
    const effectiveMaxChars = maxChars - reserveChars;
    const effectiveMaxLines = maxLines - reserveLines;
    const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
    const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
    const prefixLen = current.length > 0 ? current.length + 1 : 0;
    const segmentLimit = Math.max(1, charLimit - prefixLen);
    const segments = splitLongLine(originalLine, segmentLimit, {
      preserveWhitespace: wasInsideFence,
    });

    // Track blockquote state
    const bqMatch = originalLine.match(BQ_PREFIX_RE);
    if (bqMatch && !wasInsideFence) {
      insideBlockquote = bqMatch[1];
    } else if (!bqMatch || wasInsideFence) {
      insideBlockquote = null;
    }

    // Track table state (outside fences)
    if (!wasInsideFence) {
      if (pendingTableHeader && TABLE_SEPARATOR_RE.test(originalLine.trim())) {
        openTable = { headerLine: lastLineWasTableCandidate, separatorLine: originalLine };
        pendingTableHeader = false;
        lastLineWasTableCandidate = "";
      } else if (
        openTable &&
        originalLine.trim().startsWith("|") &&
        originalLine.trim().endsWith("|")
      ) {
        // Still inside a table (data row)
      } else if (
        originalLine.trim().startsWith("|") &&
        originalLine.trim().endsWith("|") &&
        !openTable
      ) {
        pendingTableHeader = true;
        lastLineWasTableCandidate = originalLine;
      } else {
        openTable = null;
        pendingTableHeader = false;
        lastLineWasTableCandidate = "";
      }
    }

    // Track table state inside code fences: detect pipe-delimited tables
    // so we can repeat the header when a code-fenced table splits.
    if (wasInsideFence && !fenceInfo) {
      fenceLinesAfterOpen++;
      const trimmed = originalLine.trim();
      if (fencePendingTableHeader && TABLE_SEPARATOR_RE.test(trimmed)) {
        fenceTableHeader = { headerLine: fenceLastTableCandidate, separatorLine: originalLine };
        fencePendingTableHeader = false;
        fenceLastTableCandidate = "";
      } else if (fenceTableHeader && trimmed.startsWith("|") && trimmed.endsWith("|")) {
        // Still inside a fenced table (data row)
      } else if (
        trimmed.startsWith("|") &&
        trimmed.endsWith("|") &&
        !fenceTableHeader &&
        fenceLinesAfterOpen <= 2
      ) {
        // Only treat the first content line as a candidate header
        fencePendingTableHeader = true;
        fenceLastTableCandidate = originalLine;
      } else if (fenceTableHeader && !(trimmed.startsWith("|") && trimmed.endsWith("|"))) {
        // Non-table line inside fence - clear fence table state
        fenceTableHeader = null;
        fencePendingTableHeader = false;
        fenceLastTableCandidate = "";
      }
    }

    // Reset fence-table state when a fence opens or closes
    if (fenceInfo) {
      if (!openFence) {
        // Fence opening: reset fence-table tracking
        fenceTableHeader = null;
        fencePendingTableHeader = false;
        fenceLastTableCandidate = "";
        fenceLinesAfterOpen = 0;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen
      ) {
        // Fence closing: clear fence-table state
        fenceTableHeader = null;
        fencePendingTableHeader = false;
        fenceLastTableCandidate = "";
        fenceLinesAfterOpen = 0;
      }
    }

    for (let segIndex = 0; segIndex < segments.length; segIndex++) {
      let segment = segments[segIndex];
      const isLineContinuation = segIndex > 0;

      const delimiter = isLineContinuation ? "" : current.length > 0 ? "\n" : "";
      let addition = `${delimiter}${segment}`;
      const nextLen = current.length + addition.length;
      const nextLines = currentLines + (isLineContinuation ? 0 : 1);

      const wouldExceedChars = nextLen > charLimit;
      const wouldExceedLines = nextLines > lineLimit;

      if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
        flush();
      }

      // After flush, if we're inside a blockquote, prefix the segment.
      // Recompute addition so the prefixed segment is used when appending.
      if (
        current.length === 0 &&
        insideBlockquote &&
        !segment.startsWith(insideBlockquote.trimEnd())
      ) {
        segment = applyBlockquoteToSegment(segment, insideBlockquote);
        addition = `${delimiter}${segment}`;
      }

      if (current.length > 0) {
        current += addition;
        if (!isLineContinuation) {
          currentLines += 1;
        }
      } else {
        current = segment;
        currentLines = 1;
      }
    }

    openFence = nextOpenFence;
  }

  if (current.length) {
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) {
      chunks.push(payload);
    }
  }

  return rebalanceReasoningItalics(text, rebalanceInlineFormatting(chunks));
}

export function chunkDiscordTextWithMode(
  text: string,
  opts: ChunkDiscordTextOpts & { chunkMode?: ChunkMode },
): string[] {
  const chunkMode = opts.chunkMode ?? "length";
  if (chunkMode !== "newline") {
    return chunkDiscordText(text, opts);
  }
  const lineChunks = chunkMarkdownTextWithMode(
    text,
    Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS)),
    "newline",
  );
  const chunks: string[] = [];
  for (const line of lineChunks) {
    const nested = chunkDiscordText(line, opts);
    if (!nested.length && line) {
      chunks.push(line);
      continue;
    }
    chunks.push(...nested);
  }
  return chunks;
}

/**
 * Close unmatched inline formatting markers (**, *, __, _, `) at chunk
 * boundaries and reopen them at the start of the next chunk so bold,
 * italic, and code spans render correctly when split across messages.
 */
function rebalanceInlineFormatting(chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const adjusted = [...chunks];
  let pendingReopen = "";

  for (let i = 0; i < adjusted.length; i++) {
    let chunk = adjusted[i];

    // Prepend any reopen markers from the previous chunk
    if (pendingReopen) {
      chunk = `${pendingReopen}${chunk}`;
      adjusted[i] = chunk;
    }

    if (i === adjusted.length - 1) {
      pendingReopen = "";
      break;
    }

    // Scan for unmatched markers in this chunk
    const state = scanUnmatchedInlineMarkers(chunk);
    if (state.openMarkers.length > 0) {
      const close = [...state.openMarkers].reverse().join("");
      const reopen = state.openMarkers.join("");
      adjusted[i] = `${chunk}${close}`;
      pendingReopen = reopen;
    } else {
      pendingReopen = "";
    }
  }

  return adjusted;
}

// Keep italics intact for reasoning payloads that are wrapped once with `_…_`.
// When Discord chunking splits the message, we close italics at the end of
// each chunk and reopen at the start of the next so every chunk renders
// consistently.
function rebalanceReasoningItalics(source: string, chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const opensWithReasoningItalics =
    source.startsWith("Reasoning:\n_") && source.trimEnd().endsWith("_");
  if (!opensWithReasoningItalics) {
    return chunks;
  }

  const adjusted = [...chunks];
  for (let i = 0; i < adjusted.length; i++) {
    const isLast = i === adjusted.length - 1;
    const current = adjusted[i];

    // Ensure current chunk closes italics so Discord renders it italicized.
    const needsClosing = !current.trimEnd().endsWith("_");
    if (needsClosing) {
      adjusted[i] = `${current}_`;
    }

    if (isLast) {
      break;
    }

    // Re-open italics on the next chunk if needed.
    const next = adjusted[i + 1];
    const leadingWhitespaceLen = next.length - next.trimStart().length;
    const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
    const nextBody = next.slice(leadingWhitespaceLen);
    if (!nextBody.startsWith("_")) {
      adjusted[i + 1] = `${leadingWhitespace}_${nextBody}`;
    }
  }

  return adjusted;
}
