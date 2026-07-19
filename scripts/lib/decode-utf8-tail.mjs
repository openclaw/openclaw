/**
 * Decode a byte buffer as UTF-8, skipping any leading continuation bytes that
 * would otherwise produce U+FFFD replacement characters when the buffer starts
 * inside a multibyte sequence.
 *
 * Useful for bounded-output tail helpers that retain only the last N bytes of
 * oversized text and decode the resulting byte suffix — a retained byte window
 * may start at a UTF-8 continuation byte (10xxxxxx).
 */
export function decodeUtf8Tail(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}
