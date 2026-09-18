import fs from "node:fs/promises";

const JSONL_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
const JSONL_READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE_BYTE = 0x0a;

/** Complete JSONL lines from a bounded window at the start of a file. */
export type JsonlHeadWindow = {
  lines: string[];
  /** True when the window spanned the whole file, so counts derived from it are exact. */
  complete: boolean;
  /**
   * Byte offset just past the last complete line returned. A tail window starting here resumes on
   * a record boundary, so head and tail can be concatenated without dropping or repeating a record.
   */
  endOffset: number;
  /**
   * Bytes this call actually read from the file, which is neither `maxBytes` (a short file or a
   * short read returns fewer) nor `endOffset` (bytes past the last record boundary were still
   * read). A caller budgeting I/O has to charge this rather than estimate from either.
   */
  bytesRead: number;
};

/** Complete JSONL lines from a bounded window running to the end of a file. */
export type JsonlTailWindow = {
  lines: string[];
  /**
   * Byte offset the returned lines start at, equal to a head's `endOffset` when the two windows
   * abut. `size` when the window returned no complete line, which keeps a `start <= endOffset`
   * check from mistaking an empty window for full coverage.
   */
  start: number;
  /**
   * Bytes this call actually read from the file. Zero when the floor already covered the file, and
   * non-zero even on the paths that return no complete record — the window was still read.
   */
  bytesRead: number;
};

export async function visitJsonlLines(
  file: string,
  visitor: (line: string) => boolean | void,
  chunkBytes = JSONL_READ_CHUNK_BYTES,
): Promise<{ ok: boolean; lineCount: number }> {
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return { ok: false, lineCount: 0 };
  }
  if (size <= JSONL_STREAM_THRESHOLD_BYTES) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      return { ok: false, lineCount: 0 };
    }
    if (content.length === 0) {
      return { ok: true, lineCount: 0 };
    }
    let lineCount = 0;
    for (const line of content.split(/\r?\n/u)) {
      lineCount += 1;
      if (visitor(line) === false) {
        break;
      }
    }
    return { ok: true, lineCount };
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return { ok: false, lineCount: 0 };
  }
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const decoder = new TextDecoder();
  let pendingFragments: string[] = [];
  let lineCount = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const content = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      let lineStart = 0;
      while (true) {
        const newline = content.indexOf("\n", lineStart);
        if (newline === -1) {
          break;
        }
        let rawLine = content.slice(lineStart, newline);
        if (pendingFragments.length > 0) {
          pendingFragments.push(rawLine);
          rawLine = pendingFragments.join("");
          pendingFragments = [];
        }
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        lineCount += 1;
        if (visitor(line) === false) {
          return { ok: true, lineCount };
        }
        lineStart = newline + 1;
      }
      if (lineStart < content.length) {
        pendingFragments.push(content.slice(lineStart));
      }
    }
    const decoderTail = decoder.decode();
    if (decoderTail.length > 0) {
      pendingFragments.push(decoderTail);
    }
    if (pendingFragments.length > 0) {
      const rawLine = pendingFragments.join("");
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      lineCount += 1;
      visitor(line);
    }
    return { ok: true, lineCount };
  } catch {
    return { ok: false, lineCount: 0 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Read at most `maxBytes` from the start of a JSONL file. A trailing partial line is dropped
 * unless the window reached EOF, so every returned line is a complete record.
 */
export async function readJsonlHead(
  file: string,
  maxBytes: number,
): Promise<JsonlHeadWindow | null> {
  const size = await readFileSize(file);
  if (size === undefined) {
    return null;
  }
  const window = await readFileWindow(file, 0, Math.min(maxBytes, size));
  if (!window) {
    return null;
  }
  const complete = window.length >= size;
  // Cut the window back to the last record boundary. That both guarantees complete records and
  // gives a tail window an exact offset to resume from, so neither side sees the same bytes twice.
  const endOffset = complete ? size : window.lastIndexOf(NEWLINE_BYTE) + 1;
  return {
    lines: splitCompleteLines(decodeBytes(window.subarray(0, endOffset))),
    complete,
    endOffset,
    bytesRead: window.length,
  };
}

/**
 * Read the last `maxBytes` of a JSONL file, never reaching back before `notBefore`. A leading
 * partial line is dropped unless the window began exactly on a record boundary (byte 0, or a head
 * window's `endOffset`), so no record is returned twice and any UTF-8 sequence split by the window
 * boundary falls inside that dropped fragment. The window always runs to EOF, so a rollout being
 * appended to right now can still yield a truncated final line; callers drop what will not parse.
 */
export async function readJsonlTail(
  file: string,
  maxBytes: number,
  options?: { notBefore?: number },
): Promise<JsonlTailWindow | null> {
  const size = await readFileSize(file);
  if (size === undefined) {
    return null;
  }
  const boundary = Math.min(Math.max(options?.notBefore ?? 0, 0), size);
  const start = Math.max(boundary, size - maxBytes);
  if (start >= size) {
    // The caller already read through EOF, so there is nothing left to open the file for.
    return { lines: [], start: size, bytesRead: 0 };
  }
  const window = await readFileWindow(file, start, size - start);
  if (!window) {
    return null;
  }
  if (start === boundary) {
    return { lines: splitCompleteLines(decodeBytes(window)), start, bytesRead: window.length };
  }
  const firstNewline = window.indexOf(NEWLINE_BYTE);
  if (firstNewline === -1) {
    // The whole window sits inside one oversized record, so no complete line survives it.
    return { lines: [], start: size, bytesRead: window.length };
  }
  return {
    lines: splitCompleteLines(decodeBytes(window.subarray(firstNewline + 1))),
    start: start + firstNewline + 1,
    bytesRead: window.length,
  };
}

async function readFileSize(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return undefined;
  }
}

async function readFileWindow(
  file: string,
  position: number,
  maxBytes: number,
): Promise<Buffer | null> {
  if (maxBytes <= 0) {
    return Buffer.alloc(0);
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  const buffer = Buffer.allocUnsafe(maxBytes);
  let total = 0;
  try {
    // A single read(2) may return a short count on a regular file, so fill the window explicitly.
    while (total < maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, maxBytes - total, position + total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
  return buffer.subarray(0, total);
}

function decodeBytes(bytes: Buffer): string {
  return new TextDecoder().decode(bytes);
}

/** Split a byte window already trimmed to record boundaries; the final newline yields no record. */
function splitCompleteLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
