/** Decodes frame boundaries; callers retain reader lifetime and protocol admission. */
export async function* iterateSseFrames(
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>,
  assertWithinLimit?: (pending: string) => void,
): AsyncGenerator<{ frame: string; terminated: boolean }> {
  const decoder = new TextDecoder();
  let buffer = "";
  // CRLF remains one line ending even when the delimiter expression backtracks.
  const delimiter = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/g;
  let scanOffset = 0;
  for (;;) {
    const { done, value } = await read();
    buffer += decoder.decode(value, { stream: !done });
    delimiter.lastIndex = scanOffset;
    for (;;) {
      const boundary = delimiter.exec(buffer);
      if (!boundary && (!done || !buffer)) {
        break;
      }
      const frameEnd = boundary?.index ?? buffer.length;
      const frame = buffer.slice(0, frameEnd);
      assertWithinLimit?.(frame);
      buffer = boundary ? buffer.slice(frameEnd + boundary[0].length) : "";
      delimiter.lastIndex = 0;
      yield { frame, terminated: boundary !== null };
    }
    assertWithinLimit?.(buffer);
    if (done) {
      return;
    }
    scanOffset = Math.max(0, buffer.length - 3);
  }
}
