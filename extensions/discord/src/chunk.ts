// Discord plugin module implements chunk behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";

type ChunkDiscordTextOpts = {
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
const CJK_PUNCTUATION_BREAK_AFTER_RE = /[、。，．！？；：）］｝〉》」』】〕〗〙]/u;

function resolveDiscordChunkLimit(value: unknown, fallback: number) {
  return resolveIntegerOption(value, fallback, { min: 1 });
}

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

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function clampToCodePointBoundary(text: string, index: number) {
  const boundary = Math.min(Math.max(0, index), text.length);
  if (boundary <= 0 || boundary >= text.length) {
    return boundary;
  }
  const previous = text.charCodeAt(boundary - 1);
  const next = text.charCodeAt(boundary);
  if (isHighSurrogate(previous) && isLowSurrogate(next)) {
    return boundary > 1 ? boundary - 1 : boundary + 1;
  }
  return boundary;
}

function findWhitespaceBreak(window: string) {
  for (let i = window.length - 1; i >= 0; i--) {
    if (/\s/.test(window.charAt(i))) {
      // Return the separator index so whitespace stays with the next segment.
      return i;
    }
  }
  return -1;
}

function findCjkPunctuationBreak(window: string) {
  for (let end = window.length; end > 0;) {
    const code = window.charCodeAt(end - 1);
    const start = isLowSurrogate(code) && end > 1 ? end - 2 : end - 1;
    const char = window.slice(start, end);
    if (start > 0 && CJK_PUNCTUATION_BREAK_AFTER_RE.test(char)) {
      // Return the exclusive end so CJK punctuation stays with the current segment.
      return end;
    }
    end = start;
  }
  return -1;
}

function splitLongLine(
  line: string,
  maxChars: number,
  opts: { preserveWhitespace: boolean },
): string[] {
  const limit = resolveDiscordChunkLimit(maxChars, DEFAULT_MAX_CHARS);
  if (line.length <= limit) {
    return [line];
  }
  const out: string[] = [];
  let remaining = line;
  while (remaining.length > limit) {
    if (opts.preserveWhitespace) {
      const breakIdx = clampToCodePointBoundary(remaining, limit);
      out.push(remaining.slice(0, breakIdx));
      remaining = remaining.slice(breakIdx);
      continue;
    }
    const window = remaining.slice(0, limit);
    let breakIdx = findWhitespaceBreak(window);
    if (breakIdx <= 0) {
      breakIdx = findCjkPunctuationBreak(window);
    }
    if (breakIdx <= 0) {
      breakIdx = clampToCodePointBoundary(remaining, limit);
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
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const maxChars = resolveDiscordChunkLimit(opts.maxChars, DEFAULT_MAX_CHARS);
  const maxLines = resolveDiscordChunkLimit(opts.maxLines, DEFAULT_MAX_LINES);

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
        nextOpenFence = fenceInfo;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen
      ) {
        nextOpenFence = null;
      }
    }

    // A flush can fire mid-line, before `openFence` advances to `nextOpenFence` below, so it closes
    // against the still-open `openFence`. A fence-closing line that also carries trailing text would
    // otherwise reserve 0 yet still get a closing fence appended on flush, overflowing maxChars.
    const fenceToReserve = nextOpenFence ?? openFence;
    const reserveChars = fenceToReserve ? closeFenceLine(fenceToReserve).length + 1 : 0;
    const reserveLines = fenceToReserve ? 1 : 0;
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
        current = expectDefined(segment, "current Discord chunk segment");
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
  const chunkMode = opts.chunkMode ?? "length";
  if (chunkMode !== "newline") {
    return chunkDiscordText(text, opts);
  }
  const lineChunks = chunkMarkdownTextWithMode(
    text,
    resolveDiscordChunkLimit(opts.maxChars, DEFAULT_MAX_CHARS),
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

// Whether `line` closes `open` under the same fence grammar the chunker uses:
// same marker char (` or ~) and closing run length >= open run length.
function isClosingFenceLine(line: string, open: OpenFence): boolean {
  const fenceInfo = parseFenceLine(line);
  return Boolean(
    fenceInfo && fenceInfo.markerChar === open.markerChar && fenceInfo.markerLen >= open.markerLen,
  );
}

// Leading fenced block or inline code, using the chunker's fence grammar
// (FENCE_RE / parseFenceLine): 0–3 space indent, ``` or ~~~ openers, and
// same-char closers of equal or greater length. Returns end index or -1.
// Used so reasoning-italics reopen sits *after* the code span instead of
// gluing `_` onto the opener (`_``` / `_~~~ / `_`code`).
function leadingCodeSpanEnd(body: string): number {
  if (!body) {
    return -1;
  }

  const firstNl = body.indexOf("\n");
  const firstLine = firstNl === -1 ? body : body.slice(0, firstNl);
  const openFence = parseFenceLine(firstLine);
  if (openFence) {
    if (firstNl === -1) {
      return body.length;
    }
    let lineStart = firstNl + 1;
    while (lineStart <= body.length) {
      const lineEnd = body.indexOf("\n", lineStart);
      const line = lineEnd === -1 ? body.slice(lineStart) : body.slice(lineStart, lineEnd);
      if (isClosingFenceLine(line, openFence)) {
        const fenceInfo = parseFenceLine(line);
        if (!fenceInfo) {
          return body.length;
        }
        // End after indent + markers + trailing spaces. Non-space remainder on
        // the close line (e.g. the original wrap's `_` in ```_) stays in rest.
        const markerEnd = fenceInfo.indent.length + fenceInfo.markerLen;
        const trailingSpaces = /^ */.exec(line.slice(markerEnd))?.[0].length ?? 0;
        return lineStart + markerEnd + trailingSpaces;
      }
      if (lineEnd === -1) {
        return body.length;
      }
      lineStart = lineEnd + 1;
    }
    return body.length;
  }

  // Inline code (backticks only; tildes are fence-only in this grammar).
  if (!body.startsWith("`")) {
    return -1;
  }
  const inlineOpen = /^(?<ticks>`+)/.exec(body);
  if (!inlineOpen?.groups?.ticks) {
    return -1;
  }
  const ticks = inlineOpen.groups.ticks;
  const closeAt = body.indexOf(ticks, ticks.length);
  if (closeAt === -1) {
    return body.length;
  }
  return closeAt + ticks.length;
}

function startsWithCodeDelimiter(body: string): boolean {
  if (!body) {
    return false;
  }
  const firstLine = body.split("\n", 1)[0] ?? "";
  if (parseFenceLine(firstLine)) {
    return true;
  }
  return body.startsWith("`");
}

function hasReasoningItalicsOpen(chunk: string): boolean {
  const trimmed = chunk.trimStart();
  if (trimmed.startsWith("_")) {
    return true;
  }
  if (/^(?:Reasoning:|Thinking\.{0,3})\n+_/u.test(trimmed)) {
    return true;
  }
  if (startsWithCodeDelimiter(trimmed)) {
    const codeEnd = leadingCodeSpanEnd(trimmed);
    if (codeEnd > 0) {
      return trimmed.slice(codeEnd).trimStart().startsWith("_");
    }
  }
  return false;
}

// When a continuation starts with code, protect the opener and either:
// - reopen italics after the code span when later reasoning text continues, or
// - drop a lone trailing `_` left from the original wrap on a pure-code chunk.
function reopenReasoningItalicsAfterLeadingCode(body: string): string {
  const codeEnd = leadingCodeSpanEnd(body);
  if (codeEnd <= 0) {
    return `_${body}`;
  }
  const code = body.slice(0, codeEnd);
  const rest = body.slice(codeEnd);
  if (!rest.trim()) {
    return code + rest;
  }
  // Original `_…_` closer attached after pure code — no open on this chunk.
  if (/^\s*_\s*$/.test(rest)) {
    return code;
  }
  const restWsLen = rest.length - rest.trimStart().length;
  const restWs = rest.slice(0, restWsLen);
  const restBody = rest.slice(restWsLen);
  if (restBody.startsWith("_")) {
    return code + rest;
  }
  return `${code}${restWs}_${restBody}`;
}

// Keep italics intact for reasoning payloads that are wrapped once with `_…_`.
// When Discord chunking splits the message, we close italics at the end of
// each chunk and reopen at the start of the next so every chunk renders
// consistently. Code-leading continuations reopen *after* the code span.
function rebalanceReasoningItalics(source: string, chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const opensWithReasoningItalics =
    /^(?:Reasoning:|Thinking\.{0,3})\n+_/u.test(source) && source.trimEnd().endsWith("_");
  if (!opensWithReasoningItalics) {
    return chunks;
  }

  const adjusted = [...chunks];
  for (let i = 0; i < adjusted.length; i++) {
    const isLast = i === adjusted.length - 1;
    const current = expectDefined(adjusted[i], "Discord chunk adjustment index");

    // Close only when this chunk actually opened reasoning italics. Pure code
    // continuations stay unmarked so we never emit an unmatched trailing `_`
    // after a fence (```_).
    const needsClosing = !current.trimEnd().endsWith("_") && hasReasoningItalicsOpen(current);
    if (needsClosing) {
      adjusted[i] = `${current}_`;
    }

    if (isLast) {
      break;
    }

    const next = expectDefined(adjusted[i + 1], "non-final Discord chunk successor");
    const leadingWhitespaceLen = next.length - next.trimStart().length;
    const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
    const nextBody = next.slice(leadingWhitespaceLen);
    if (nextBody.startsWith("_")) {
      continue;
    }
    // Fence (``` / ~~~, optional 0–3 indent restored via leadingWhitespace) or inline code.
    if (startsWithCodeDelimiter(nextBody)) {
      adjusted[i + 1] = `${leadingWhitespace}${reopenReasoningItalicsAfterLeadingCode(nextBody)}`;
      continue;
    }
    adjusted[i + 1] = `${leadingWhitespace}_${nextBody}`;
  }

  return adjusted;
}
