import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";

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
  /**
   * If true, split mixed prose + fenced code responses into distinct message
   * groups before normal Discord chunking runs.
   */
  splitOnCodeBlocks?: boolean;
};

type OpenFence = {
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
};

type FenceLine = {
  indent: string;
  markerChar: string;
  markerLen: number;
  trailing: string;
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

function parseFenceLine(line: string): FenceLine | null {
  const match = line.match(FENCE_RE);
  if (!match) {
    return null;
  }
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  const trailing = match[3] ?? "";
  return {
    indent,
    markerChar: marker[0] ?? "`",
    markerLen: marker.length,
    trailing,
    openLine: line,
  };
}

function closeFenceLine(openFence: OpenFence) {
  return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}

function isValidFenceOpener(fenceInfo: FenceLine): boolean {
  // CommonMark: for backtick fences, the info string (everything after the opening backticks)
  // must not contain any backtick characters.
  if (fenceInfo.markerChar !== "`") {
    return true;
  }
  return !fenceInfo.trailing.includes("`");
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

function splitLinesPreserveNewlines(text: string): string[] {
  const matches = text.match(/[^\n]*\n|[^\n]+$/g);
  return matches ?? [];
}

function trimTrailingNewline(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

function mergeWhitespaceOnlySegments(segments: string[]): string[] {
  const merged = [...segments];
  for (let i = 0; i < merged.length; i++) {
    const segment = merged[i];
    if (!segment || segment.trim().length > 0) {
      continue;
    }
    const prevIndex = i - 1;
    const nextIndex = i + 1;
    if (prevIndex >= 0 && merged[prevIndex]) {
      merged[prevIndex] += segment;
      merged[i] = "";
      continue;
    }
    if (nextIndex < merged.length && merged[nextIndex]) {
      merged[nextIndex] = `${segment}${merged[nextIndex]}`;
      merged[i] = "";
    }
  }
  return merged.filter(Boolean);
}

function moveLeadingNewlinesToPreviousSegment(segments: string[]): string[] {
  const moved = [...segments];
  for (let i = 1; i < moved.length; i++) {
    const segment = moved[i];
    if (!segment) {
      continue;
    }
    const leadingNewlineMatch = segment.match(/^\n+/);
    if (!leadingNewlineMatch || !leadingNewlineMatch[0]) {
      continue;
    }
    const leadingNewlines = leadingNewlineMatch[0];
    moved[i - 1] += leadingNewlines;
    moved[i] = segment.slice(leadingNewlines.length);
  }
  return moved.filter(Boolean);
}

export function splitDiscordTextOnCodeBlocks(text: string): string[] {
  const body = text ?? "";
  if (!body) {
    return [];
  }

  const lines = splitLinesPreserveNewlines(body);
  if (lines.length === 0) {
    return [body];
  }

  const segments: string[] = [];
  let current = "";
  let openFence: OpenFence | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    segments.push(current);
    current = "";
  };

  for (const line of lines) {
    const fenceInfo = parseFenceLine(trimTrailingNewline(line));
    if (!openFence && fenceInfo && isValidFenceOpener(fenceInfo)) {
      flush();
      current = line;
      openFence = fenceInfo;
      continue;
    }

    current += line;

    if (
      openFence &&
      fenceInfo &&
      openFence.markerChar === fenceInfo.markerChar &&
      fenceInfo.markerLen >= openFence.markerLen &&
      fenceInfo.trailing.trim().length === 0
    ) {
      flush();
      openFence = null;
    }
  }

  flush();
  const merged = mergeWhitespaceOnlySegments(segments);
  const normalized = moveLeadingNewlinesToPreviousSegment(merged);
  return normalized.length > 0 ? normalized : [body];
}

/**
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
export function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));

  const body = text ?? "";
  if (!body) {
    return [];
  }

  const alreadyOk = body.length <= maxChars && countLines(body) <= maxLines;
  if (alreadyOk) {
    return [body];
  }

  const lines = body.split("\n");
  const chunks: string[] = [];

  let current = "";
  let currentLines = 0;
  let openFence: OpenFence | null = null;

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
    if (openFence) {
      current = openFence.openLine;
      currentLines = 1;
    }
  };

  for (const originalLine of lines) {
    const fenceInfo = parseFenceLine(originalLine);
    const wasInsideFence = openFence !== null;
    let nextOpenFence: OpenFence | null = openFence;
    if (fenceInfo) {
      if (!openFence) {
        nextOpenFence = isValidFenceOpener(fenceInfo) ? fenceInfo : null;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen &&
        fenceInfo.trailing.trim().length === 0
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

    for (let segIndex = 0; segIndex < segments.length; segIndex++) {
      const segment = segments[segIndex];
      const isLineContinuation = segIndex > 0;
      const delimiter = isLineContinuation ? "" : current.length > 0 ? "\n" : "";
      const addition = `${delimiter}${segment}`;
      const nextLen = current.length + addition.length;
      const nextLines = currentLines + (isLineContinuation ? 0 : 1);

      const wouldExceedChars = nextLen > charLimit;
      const wouldExceedLines = nextLines > lineLimit;

      if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
        flush();
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

  return rebalanceReasoningItalics(text, chunks);
}

export function chunkDiscordTextWithMode(
  text: string,
  opts: ChunkDiscordTextOpts & { chunkMode?: ChunkMode },
): string[] {
  if (opts.splitOnCodeBlocks) {
    const groups = splitDiscordTextOnCodeBlocks(text);
    const chunks: string[] = [];
    for (const group of groups) {
      const nested = chunkDiscordTextWithMode(group, {
        ...opts,
        splitOnCodeBlocks: false,
      });
      if (!nested.length) {
        if (group.trim()) {
          chunks.push(group);
        }
        continue;
      }
      chunks.push(...nested);
    }
    return chunks;
  }

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
