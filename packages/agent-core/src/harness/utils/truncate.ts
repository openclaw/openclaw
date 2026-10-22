export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

/** Result metadata for content truncated by line count, byte count, or both. */
export interface TruncationResult {
  /** The truncated content */
  content: string;
  /** Whether truncation occurred */
  truncated: boolean;
  /** Which limit was hit: "lines", "bytes", or null if not truncated */
  truncatedBy: "lines" | "bytes" | null;
  /** Total number of lines in the original content */
  totalLines: number;
  /** Total number of bytes in the original content */
  totalBytes: number;
  /** Number of complete lines in the truncated output */
  outputLines: number;
  /** Number of bytes in the truncated output */
  outputBytes: number;
  /** Whether the text-page owner retained a partial display line. */
  lastLinePartial: boolean;
  /** Whether the first line exceeded the byte limit (for head truncation) */
  firstLineExceedsLimit: boolean;
  /** The max lines limit that was applied */
  maxLines: number;
  /** The max bytes limit that was applied */
  maxBytes: number;
}

type ResolvedTruncationInput = ReturnType<typeof resolveTruncationInput>;

interface RuntimeBuffer {
  byteLength(content: string, encoding: "utf8"): number;
  from(content: string, encoding: "utf16le"): { toString(encoding: "utf16le"): string };
}

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;

function copyString(content: string): string {
  // Copy selected code units without normalizing lone surrogates or retaining the source backing.
  return runtimeBuffer ? runtimeBuffer.from(content, "utf16le").toString("utf16le") : content;
}

function findFirstNonAscii(content: string): number {
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) > 0x7f) {
      return index;
    }
  }
  return -1;
}

function utf8ByteLength(content: string): number {
  if (runtimeBuffer) {
    return runtimeBuffer.byteLength(content, "utf8");
  }

  const firstNonAscii = findFirstNonAscii(content);
  if (firstNonAscii === -1) {
    return content.length;
  }

  let bytes = firstNonAscii;
  for (let i = firstNonAscii; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
      const next = content.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Format byte counts for compact tool-output diagnostics.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function resolveTruncationInput(content: string, maxBytes: number) {
  let totalLines = content.length > 0 && !content.endsWith("\n") ? 1 : 0;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
    totalLines++;
  }
  return {
    totalLines,
    totalBytes: utf8ByteLength(content),
    maxLines: DEFAULT_MAX_LINES,
    maxBytes,
  };
}

function buildTruncationResult(
  input: ResolvedTruncationInput,
  params: {
    content: string;
    truncatedBy?: TruncationResult["truncatedBy"];
    outputLines?: number;
    outputBytes?: number;
    firstLineExceedsLimit?: boolean;
  },
): TruncationResult {
  let truncatedBy = params.truncatedBy ?? null;
  const outputLines = params.outputLines ?? input.totalLines;
  const outputBytes = params.outputBytes ?? input.totalBytes;
  if (
    !params.firstLineExceedsLimit &&
    input.totalLines > input.maxLines &&
    outputLines >= input.maxLines &&
    outputBytes <= input.maxBytes
  ) {
    truncatedBy = "lines";
  }
  const truncated = truncatedBy !== null;
  return {
    // One-element joins can retain a source slice; multiline joins build their own text.
    content: truncated && outputLines === 1 ? copyString(params.content) : params.content,
    truncated,
    truncatedBy,
    totalLines: input.totalLines,
    totalBytes: input.totalBytes,
    outputLines,
    outputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: params.firstLineExceedsLimit ?? false,
    maxLines: input.maxLines,
    maxBytes: input.maxBytes,
  };
}

/**
 * Keep the beginning of content while respecting independent line and byte ceilings.
 *
 * Head truncation preserves complete lines; a first line that exceeds the byte
 * ceiling produces empty output and sets firstLineExceedsLimit.
 */
export function truncateHead(content: string, maxBytes: number): TruncationResult {
  const input = resolveTruncationInput(content, maxBytes);

  if (input.totalLines <= input.maxLines && input.totalBytes <= input.maxBytes) {
    return buildTruncationResult(input, { content });
  }

  const firstLineEnd = content.indexOf("\n");
  const firstLine = content.slice(0, firstLineEnd === -1 ? content.length : firstLineEnd);
  if (input.totalLines > 0 && utf8ByteLength(firstLine) > input.maxBytes) {
    return buildTruncationResult(input, {
      content: "",
      truncatedBy: "bytes",
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
    });
  }

  const outputLines: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = input.totalLines > input.maxLines ? "lines" : "bytes";
  const selectedLines = Math.min(input.totalLines, input.maxLines);
  for (let start = 0; outputLines.length < selectedLines;) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline;
    const line = content.slice(start, end);
    const lineBytes = utf8ByteLength(line) + (outputLines.length > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > input.maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    outputLines.push(line);
    start = end + 1;
    outputBytesCount += lineBytes;
  }

  return buildTruncationResult(input, {
    content: outputLines.join("\n"),
    truncatedBy,
    outputLines: outputLines.length,
    outputBytes: outputBytesCount,
  });
}
