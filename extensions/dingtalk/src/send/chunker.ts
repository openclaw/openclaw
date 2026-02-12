/**
 * Text chunking utilities for DingTalk message limits.
 * Preserves markdown code fences and tries to break on natural boundaries.
 */

/**
 * Parse fence spans (``` or ~~~ code blocks) in markdown text.
 * Returns array of {start, end} positions for each closed fence.
 */
function parseFenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const fencePattern = /^(`{3,}|~{3,})(\w*)?\s*$/gm;
  let match: RegExpExecArray | null;
  let openFence: string | null = null;
  let openIndex = 0;

  while ((match = fencePattern.exec(text)) !== null) {
    const fence = match[1];
    const matchIndex = match.index;

    if (!openFence) {
      // Opening fence
      openFence = fence[0]; // '`' or '~'
      openIndex = matchIndex;
    } else if (fence[0] === openFence && fence.length >= openFence.length) {
      // Matching closing fence
      spans.push({ start: openIndex, end: matchIndex + match[0].length });
      openFence = null;
    }
  }

  return spans;
}

/**
 * Check if a position is safe to break (not inside a fence).
 */
function isSafeBreakpoint(
  position: number,
  fenceSpans: Array<{ start: number; end: number }>,
): boolean {
  for (const span of fenceSpans) {
    if (position > span.start && position < span.end) {
      return false;
    }
  }
  return true;
}

/**
 * Split long text into chunks under maxChars.
 * Tries to split on paragraph boundaries first, then lines, then punctuation.
 */
export function chunkText(text: string, maxChars: number): string[] {
  const s = (text ?? "").toString();
  if (s.length <= maxChars) {
    return [s];
  }

  const chunks: string[] = [];
  let remaining = s;

  const pushChunk = (c: string): void => {
    const v = c.trim();
    if (v) {
      chunks.push(v);
    }
  };

  while (remaining.length > maxChars) {
    // Try split by double newline within limit
    let cut = remaining.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars * 0.5) {
      // Try split by single newline
      cut = remaining.lastIndexOf("\n", maxChars);
    }
    if (cut < maxChars * 0.5) {
      // Try split by punctuation (Chinese + English)
      const punct = ["。", "！", "？", ".", "!", "?", "；", ";"];
      for (const p of punct) {
        const idx = remaining.lastIndexOf(p, maxChars);
        if (idx > cut) {
          cut = idx + p.length;
        }
      }
    }
    if (cut < maxChars * 0.4) {
      // Hard cut
      cut = maxChars;
    }

    pushChunk(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  pushChunk(remaining);
  return chunks;
}

/**
 * Split markdown text into chunks, never breaking inside code fences.
 * Uses same chunking strategy as chunkText() but respects ``` and ~~~ blocks.
 */
export function chunkMarkdownText(text: string, maxChars: number): string[] {
  const s = (text ?? "").toString();
  if (s.length <= maxChars) {
    return [s];
  }

  const fenceSpans = parseFenceSpans(s);
  const chunks: string[] = [];
  let remaining = s;

  while (remaining.length > maxChars) {
    // Try paragraph break
    let cut = remaining.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars * 0.5) {
      // Try single newline
      cut = remaining.lastIndexOf("\n", maxChars);
    }
    if (cut < maxChars * 0.5) {
      // Try punctuation (Chinese + English)
      const punct = ["。", "！", "？", ".", "!", "?", "；", ";"];
      for (const p of punct) {
        const idx = remaining.lastIndexOf(p, maxChars);
        if (idx > cut) {
          cut = idx + p.length;
        }
      }
    }
    if (cut < maxChars * 0.4) {
      // Hard cut
      cut = maxChars;
    }

    // Check if safe (not inside fence)
    const globalPos = s.length - remaining.length + cut;
    if (!isSafeBreakpoint(globalPos, fenceSpans)) {
      // Find the end of the fence we're inside
      for (const span of fenceSpans) {
        if (globalPos > span.start && globalPos < span.end) {
          // Move cut to end of fence
          cut = span.end - (s.length - remaining.length);
          break;
        }
      }
    }

    const chunk = remaining.slice(0, cut).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(cut);
  }

  const final = remaining.trim();
  if (final) {
    chunks.push(final);
  }

  return chunks;
}

/**
 * Convert value to clean string.
 */
export function toCleanString(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  if (v instanceof Error) {
    return v.message;
  }
  if (typeof v === "symbol") {
    return v.toString();
  }
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "[unserializable]";
    }
  }
  if (typeof v === "function") {
    return v.toString();
  }
  return "";
}

/**
 * Normalize text for DingTalk messages.
 */
export function normalizeForTextMessage(text: string): string {
  return toCleanString(text).replace(/\r\n/g, "\n");
}
