/**
 * Payload redaction utilities for diagnostic logging.
 *
 * These functions strip content that should never appear in debug log files —
 * e.g. large base64 image blobs — while preserving the structural shape of the
 * payload so log consumers can still inspect message roles, tool calls, etc.
 */

const CIRCULAR_PLACEHOLDER = "[Circular]";

function redactImageSource(source: Record<string, unknown>): Record<string, unknown> {
  if (source.type !== "base64" || typeof source.data !== "string") {
    return source;
  }
  return { ...source, data: redactBase64Data(source.data) };
}

function redactBase64Data(data: string): string {
  // Approximate decoded byte length from base64 length.
  const byteLen = Math.ceil((data.length * 3) / 4);
  const kb = Math.round(byteLen / 1024);
  return `<redacted:${kb}kb>`;
}

function redactContentBlock(block: unknown): unknown {
  if (!block || typeof block !== "object") {
    return block;
  }
  const b = block as Record<string, unknown>;
  if (b.type !== "image") {
    return block;
  }
  let next: Record<string, unknown> | null = null;

  if (b.source && typeof b.source === "object") {
    const redacted = redactImageSource(b.source as Record<string, unknown>);
    if (redacted !== b.source) {
      next = { ...(next ?? b), source: redacted };
    }
  }
  if (typeof b.data === "string") {
    const redactedData = redactBase64Data(b.data);
    if (redactedData !== b.data) {
      next = { ...(next ?? b), data: redactedData };
    }
  }

  return next ?? block;
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
function redactDeep(
  value: unknown,
  seen: WeakSet<object>,
  memo: WeakMap<object, unknown>,
): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (memo.has(value)) {
    return memo.get(value);
  }
  if (seen.has(value)) {
    return CIRCULAR_PLACEHOLDER;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const next = value.map((item) => redactDeep(item, seen, memo));
      const result = next.every((v, i) => v === (value as unknown[])[i]) ? value : next;
      memo.set(value, result);
      return result;
    }

    // Try content-block redaction first (fast path for {type:"image", source|data}).
    const asBlock = redactContentBlock(value);
    if (asBlock !== value) {
      memo.set(value, asBlock);
      return asBlock;
    }

    // Recurse into all object values.
    const obj = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const r = redactDeep(obj[key], seen, memo);
      next[key] = r;
      if (r !== obj[key]) changed = true;
    }
    const result = changed ? next : value;
    memo.set(value, result);
    return result;
  } finally {
    seen.delete(value);
  }
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
  return redactDeep(payload, new WeakSet<object>(), new WeakMap<object, unknown>());
}
