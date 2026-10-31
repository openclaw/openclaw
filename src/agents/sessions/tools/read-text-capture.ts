export type ReadTextCapture = {
  content: string;
  totalLines?: number;
  selectedLineCount: number;
  firstLineLength: number;
  selectedHasText: boolean;
  cursorSplitsSurrogatePair: boolean;
  totalBytes?: number;
};

/** Retain one page; callers that stop before EOF must not claim complete totals. */
export function createReadTextCapture(params: {
  offset: number;
  cursor: number;
  limit?: number;
  maxChars: number;
  stopEarly?: boolean;
  maxLines?: number;
}) {
  const startLine = params.offset - 1;
  const parts: string[] = [];
  let capturedChars = 0;
  let selectedChars = 0;
  let totalBytes = 0;
  let line = 0;
  let lineLength = 0;
  let firstLineLength = 0;
  let selectedHasText = false;
  let pendingCr = "";
  let cursorBefore = 0;
  let cursorAfter = 0;
  let fullyScanned = true;
  const pageComplete = () =>
    capturedChars >= params.maxChars ||
    line >= startLine + Math.min(params.limit ?? Infinity, params.maxLines ?? Infinity);
  const selected = () =>
    line >= startLine && (params.limit === undefined || line < startLine + params.limit);
  const append = (text: string) => {
    selectedChars += text.length;
    totalBytes += Buffer.byteLength(text, "utf8");
    const remaining = params.maxChars - capturedChars;
    if (remaining > 0) {
      const prefix = text.slice(0, remaining);
      parts.push(prefix);
      capturedChars += prefix.length;
    }
  };
  const scan = (text: string) => {
    for (let start = 0; start < text.length;) {
      if (params.stopEarly && pageComplete()) {
        fullyScanned = false;
        break;
      }
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      const segment = text.slice(start, end);
      if (selected()) {
        selectedHasText ||= segment.length > 0;
        if (line === startLine) {
          const before = params.cursor - 1 - lineLength;
          const after = params.cursor - lineLength;
          if (before >= 0 && before < segment.length) {
            cursorBefore = segment.charCodeAt(before);
          }
          if (after >= 0 && after < segment.length) {
            cursorAfter = segment.charCodeAt(after);
          }
          append(segment.slice(Math.max(0, params.cursor - lineLength)));
          firstLineLength += segment.length;
        } else {
          append(segment);
        }
        if (newline !== -1) {
          append("\n");
        }
      }
      lineLength += segment.length;
      if (newline !== -1) {
        line += 1;
        lineLength = 0;
      }
      start = end + 1;
    }
  };
  return {
    write(text: string) {
      let normalized = pendingCr + text;
      pendingCr = normalized.endsWith("\r") ? "\r" : "";
      if (pendingCr) {
        normalized = normalized.slice(0, -1);
      }
      scan(normalized.replaceAll("\r\n", "\n"));
      return !params.stopEarly || !pageComplete();
    },
    finish(complete = true): ReadTextCapture {
      scan(pendingCr);
      const observedLines = line + Number(lineLength > 0);
      const totalLines = complete && fullyScanned ? observedLines : undefined;
      const selectedLineCount = Math.max(
        0,
        Math.min(
          observedLines - startLine,
          params.limit ?? observedLines,
          params.stopEarly ? (params.maxLines ?? observedLines) : observedLines,
        ),
      );
      let content = parts.join("");
      // A limited range excludes its final separator unless that separator is EOF.
      if (
        selectedLineCount > 0 &&
        (totalLines === undefined
          ? line >= startLine + selectedLineCount
          : startLine + selectedLineCount < totalLines)
      ) {
        totalBytes -= 1;
        if (capturedChars === selectedChars) {
          content = content.slice(0, -1);
        }
      }
      const last = content.charCodeAt(content.length - 1);
      if (capturedChars < selectedChars && last >= 0xd800 && last <= 0xdbff) {
        content = content.slice(0, -1);
      }
      return {
        content,
        ...(totalLines === undefined ? {} : { totalLines, totalBytes }),
        selectedLineCount,
        firstLineLength,
        selectedHasText,
        cursorSplitsSurrogatePair:
          cursorBefore >= 0xd800 &&
          cursorBefore <= 0xdbff &&
          cursorAfter >= 0xdc00 &&
          cursorAfter <= 0xdfff,
      };
    },
  };
}
