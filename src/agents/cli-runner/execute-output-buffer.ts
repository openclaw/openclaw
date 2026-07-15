const CLI_RUNNER_OUTPUT_TAIL_BYTES = 64 * 1024;

function trimLeadingUtf8ContinuationBytes(buffer: Buffer): Buffer {
  let start = 0;
  while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) {
    start++;
  }
  return start === 0 ? buffer : buffer.subarray(start);
}

export function appendCliOutputTail(tail: Buffer, chunk: string): Buffer {
  if (!chunk) {
    return tail;
  }
  const chunkBuffer = Buffer.from(chunk);
  if (chunkBuffer.byteLength >= CLI_RUNNER_OUTPUT_TAIL_BYTES) {
    return Buffer.from(
      trimLeadingUtf8ContinuationBytes(
        chunkBuffer.subarray(chunkBuffer.byteLength - CLI_RUNNER_OUTPUT_TAIL_BYTES),
      ),
    );
  }
  const next = Buffer.concat([tail, chunkBuffer], tail.byteLength + chunkBuffer.byteLength);
  if (next.byteLength <= CLI_RUNNER_OUTPUT_TAIL_BYTES) {
    return next;
  }
  return Buffer.from(
    trimLeadingUtf8ContinuationBytes(next.subarray(next.byteLength - CLI_RUNNER_OUTPUT_TAIL_BYTES)),
  );
}
