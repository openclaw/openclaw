import {
  chunkMarkdownTextWithMode,
  chunkMarkdownWithBalancedFences,
  type ChunkMode,
} from "openclaw/plugin-sdk/reply-chunking";

export type ChunkDiscordTextOpts = {
  /** Max characters per Discord message. Default: 1950. */
  maxChars?: number;
  /**
   * Optional soft max line count per message.
   *
   * When omitted, Discord chunking prioritizes minimizing message count and
   * only splits on character limits.
   */
  maxLines?: number;
};

type OpenFence = {
  hasInfoString: boolean;
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
};

type FenceSpan = OpenFence & {
  closed: boolean;
  start: number;
  end: number;
};

type FenceState = {
  leadingOpenFence: FenceSpan | null;
  spans: FenceSpan[];
  trailingOpenFence: FenceSpan | null;
};

const DEFAULT_MAX_CHARS = 1950;
const DEFAULT_MAX_LINES = Number.MAX_SAFE_INTEGER;
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
  const suffix = match[3] ?? "";
  return {
    hasInfoString: suffix.trim().length > 0,
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

function parseFenceSpans(text: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  let openFence: FenceSpan | null = null;
  let offset = 0;
  while (offset <= text.length) {
    const nextNewline = text.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const line = text.slice(offset, lineEnd);
    const fence = parseFenceLine(line);
    if (fence) {
      if (!openFence) {
        openFence = {
          closed: false,
          ...fence,
          start: offset,
          end: text.length,
        };
      } else if (
        openFence.markerChar === fence.markerChar &&
        fence.markerLen >= openFence.markerLen
      ) {
        openFence.end = lineEnd;
        openFence.closed = true;
        spans.push(openFence);
        openFence = null;
      }
    }
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }
  if (openFence) {
    spans.push(openFence);
  }
  return spans;
}

function findTrailingOpenFence(spans: FenceSpan[]): FenceSpan | null {
  const last = spans.at(-1);
  if (!last || last.closed) {
    return null;
  }
  return last;
}

function getFenceState(text: string): FenceState {
  const spans = parseFenceSpans(text);
  const trailingOpenFence = findTrailingOpenFence(spans);
  return {
    spans,
    trailingOpenFence,
    leadingOpenFence: trailingOpenFence?.start === 0 ? trailingOpenFence : null,
  };
}

function renderChunkWithFence(text: string, openFence: OpenFence | null): string {
  return closeFenceIfNeeded(text, openFence);
}

function getStandaloneChunkFence(text: string, fenceState: FenceState): FenceSpan | null {
  if (fenceState.leadingOpenFence) {
    return fenceState.leadingOpenFence;
  }
  const trailing = fenceState.trailingOpenFence;
  if (!trailing) {
    return null;
  }
  if (trailing.hasInfoString || trailing.start === 0) {
    return trailing;
  }
  const trailingBody = text.slice(trailing.start + trailing.openLine.length);
  return trailingBody.length > 0 ? trailing : null;
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
    remaining = remaining.slice(breakIdx);
  }
  if (remaining.length) {
    out.push(remaining);
  }
  return out;
}

function chunkDiscordTextByLines(text: string, opts: ChunkDiscordTextOpts): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));

  const body = text ?? "";
  if (!body) {
    return [];
  }

  const bodyFenceState = getFenceState(body);
  const renderedBody = renderChunkWithFence(body, getStandaloneChunkFence(body, bodyFenceState));
  const alreadyOk = renderedBody.length <= maxChars && countLines(renderedBody) <= maxLines;
  if (alreadyOk) {
    return [renderedBody];
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
      while (true) {
        const delimiter = isLineContinuation ? "" : current.length > 0 ? "\n" : "";
        const addition = `${delimiter}${segment}`;
        const nextLen = current.length + addition.length;
        const nextLines = currentLines + (isLineContinuation ? 0 : 1);

        const wouldExceedChars = nextLen > charLimit;
        const wouldExceedLines = nextLines > lineLimit;

        if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
          const beforeFlush = current;
          flush();
          if (current === beforeFlush) {
            // Reopening the exact same buffer would loop forever. Keep a minimal
            // fence marker so following content stays fenced without exceeding
            // the explicit line-mode char budget.
            current = nextOpenFence ? closeFenceLine(nextOpenFence) : "";
            currentLines = current.length > 0 ? 1 : 0;
            openFence = nextOpenFence;
          }
          continue;
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
        break;
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

export function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));
  const body = text ?? "";
  if (!body) {
    return [];
  }

  if (maxLines < Number.MAX_SAFE_INTEGER) {
    return chunkDiscordTextByLines(text, opts);
  }

  return rebalanceReasoningItalics(
    text,
    chunkMarkdownWithBalancedFences(body, {
      maxChars,
    }),
  );
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

    const needsClosing = !current.trimEnd().endsWith("_");
    if (needsClosing) {
      adjusted[i] = `${current}_`;
    }

    if (isLast) {
      break;
    }

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
