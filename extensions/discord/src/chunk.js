import { chunkMarkdownTextWithMode } from "../../../src/auto-reply/chunk.js";
const DEFAULT_MAX_CHARS = 2e3;
const DEFAULT_MAX_LINES = 17;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
function countLines(text) {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}
function parseFenceLine(line) {
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
    openLine: line
  };
}
function closeFenceLine(openFence) {
  return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}
function closeFenceIfNeeded(text, openFence) {
  if (!openFence) {
    return text;
  }
  const closeLine = closeFenceLine(openFence);
  if (!text) {
    return closeLine;
  }
  if (!text.endsWith("\n")) {
    return `${text}
${closeLine}`;
  }
  return `${text}${closeLine}`;
}
function splitLongLine(line, maxChars, opts) {
  const limit = Math.max(1, Math.floor(maxChars));
  if (line.length <= limit) {
    return [line];
  }
  const out = [];
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
function chunkDiscordText(text, opts = {}) {
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
  const chunks = [];
  let current = "";
  let currentLines = 0;
  let openFence = null;
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
    let nextOpenFence = openFence;
    if (fenceInfo) {
      if (!openFence) {
        nextOpenFence = fenceInfo;
      } else if (openFence.markerChar === fenceInfo.markerChar && fenceInfo.markerLen >= openFence.markerLen) {
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
      preserveWhitespace: wasInsideFence
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
function chunkDiscordTextWithMode(text, opts) {
  const chunkMode = opts.chunkMode ?? "length";
  if (chunkMode !== "newline") {
    return chunkDiscordText(text, opts);
  }
  const lineChunks = chunkMarkdownTextWithMode(
    text,
    Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS)),
    "newline"
  );
  const chunks = [];
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
function rebalanceReasoningItalics(source, chunks) {
  if (chunks.length <= 1) {
    return chunks;
  }
  const opensWithReasoningItalics = source.startsWith("Reasoning:\n_") && source.trimEnd().endsWith("_");
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
export {
  chunkDiscordText,
  chunkDiscordTextWithMode
};
