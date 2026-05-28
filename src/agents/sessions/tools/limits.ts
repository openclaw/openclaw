export function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export const SESSION_TOOL_STDERR_TAIL_BYTES = 64 * 1024;

export function appendBoundedTextTail(
  current: string,
  chunk: Buffer | string,
  maxBytes = SESSION_TOOL_STDERR_TAIL_BYTES,
): string {
  const effectiveMaxBytes = normalizePositiveLimit(maxBytes, SESSION_TOOL_STDERR_TAIL_BYTES);
  const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (chunkBuffer.byteLength >= effectiveMaxBytes) {
    return chunkBuffer.subarray(chunkBuffer.byteLength - effectiveMaxBytes).toString("utf8");
  }

  const currentBuffer = Buffer.from(current);
  const nextBytes = currentBuffer.byteLength + chunkBuffer.byteLength;
  if (nextBytes <= effectiveMaxBytes) {
    return `${current}${chunkBuffer.toString("utf8")}`;
  }

  const currentTailBytes = Math.max(0, effectiveMaxBytes - chunkBuffer.byteLength);
  const currentTail = currentBuffer.subarray(currentBuffer.byteLength - currentTailBytes);
  return Buffer.concat([currentTail, chunkBuffer], effectiveMaxBytes).toString("utf8");
}
