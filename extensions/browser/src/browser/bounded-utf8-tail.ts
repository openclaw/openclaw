/** Byte-bounded UTF-8 tail storage for browser subprocess diagnostics. */

function decodeUtf8Tail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

export function decodeBoundedUtf8Tail(buffer: Buffer, maxBytes: number): string {
  if (maxBytes <= 0 || buffer.length === 0) {
    return "";
  }
  const tail = buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes) : buffer;
  return decodeUtf8Tail(tail);
}

export function createBoundedUtf8Tail(maxBytes: number) {
  let chunks: Buffer[] = [];
  let totalBytes = 0;

  return {
    append(chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length === 0 || maxBytes <= 0) {
        return;
      }
      if (buffer.length >= maxBytes) {
        chunks = [buffer.subarray(buffer.length - maxBytes)];
        totalBytes = maxBytes;
        return;
      }

      chunks.push(buffer);
      totalBytes += buffer.length;
      while (totalBytes > maxBytes) {
        const first = chunks[0]!;
        const overflowBytes = totalBytes - maxBytes;
        if (overflowBytes < first.length) {
          chunks[0] = first.subarray(overflowBytes);
          totalBytes -= overflowBytes;
          break;
        }
        chunks.shift();
        totalBytes -= first.length;
      }
    },
    text() {
      return decodeUtf8Tail(Buffer.concat(chunks, totalBytes));
    },
    clear() {
      chunks = [];
      totalBytes = 0;
    },
  };
}
