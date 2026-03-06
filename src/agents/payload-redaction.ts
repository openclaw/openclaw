/**
 * Payload redaction utilities for diagnostic logging.
 *
 * These functions strip content that should never appear in debug log files —
 * e.g. large base64 image blobs — while preserving the structural shape of the
 * payload so log consumers can still inspect message roles, tool calls, etc.
 */

function redactImageSource(source: Record<string, unknown>): Record<string, unknown> {
  if (source.type !== "base64" || typeof source.data !== "string") {
    return source;
  }
  // Approximate decoded byte length from base64 length.
  const byteLen = Math.ceil((source.data.length * 3) / 4);
  const kb = Math.round(byteLen / 1024);
  return { ...source, data: `<redacted:${kb}kb>` };
}

function redactContentBlock(block: unknown): unknown {
  if (!block || typeof block !== "object") {
    return block;
  }
  const b = block as Record<string, unknown>;
  if (b.type !== "image" || !b.source || typeof b.source !== "object") {
    return block;
  }
  const redacted = redactImageSource(b.source as Record<string, unknown>);
  if (redacted === b.source) {
    return block;
  }
  return { ...b, source: redacted };
}

function redactMessageContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  const next = content.map(redactContentBlock);
  return next.every((v, i) => v === content[i]) ? content : next;
}

function redactMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const m = message as Record<string, unknown>;
  if (!("content" in m)) {
    return message;
  }
  const content = redactMessageContent(m.content);
  return content === m.content ? message : { ...m, content };
}

/**
 * Recursively walk any value and redact base64 image content blocks wherever
 * they appear — inside messages, options.images, or any other nested location.
 * Returns the same reference when nothing was redacted (zero allocation).
 */
function redactDeep(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const next = value.map(redactDeep);
    return next.every((v, i) => v === (value as unknown[])[i]) ? value : next;
  }
  // Try content-block redaction first (fast path for {type:"image", source:...}).
  const asBlock = redactContentBlock(value);
  if (asBlock !== value) {
    return asBlock;
  }
  // Recurse into all object values.
  const obj = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const r = redactDeep(obj[key]);
    next[key] = r;
    if (r !== obj[key]) changed = true;
  }
  return changed ? next : value;
}

/**
 * Return a copy of `payload` with base64 image data replaced by byte-count
 * placeholders. Non-image content is preserved verbatim.
 *
 * The original `payload` reference is never mutated; if no images are present
 * the same reference is returned (zero allocation).
 *
 * Image blocks are redacted wherever they appear in the payload structure —
 * inside `messages[*].content`, `options.images`, or any other nested location.
 */
export function redactImageDataForDiagnostics(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  return redactDeep(payload);
}
