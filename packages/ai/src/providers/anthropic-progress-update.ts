import type { TextContent } from "@openclaw/llm-core";

// Opus 5.5, Sonnet 5.5, Fable and Mythos return the notes they write for the
// user between tool calls as signed `thinking` blocks ("progress updates").
// Under `display: "summarized"` the API gives them no field that separates
// them from reasoning. Their signature metadata does: like Claude Code, read
// the kind label at protobuf field 2 > 1 > 8, which is "narration" for them.
const PROGRESS_UPDATE_KIND = "narration";

function readVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; next: number } | undefined {
  let value = 0;
  for (let index = offset; index < bytes.length && index - offset < 5; index += 1) {
    const byte = bytes[index] ?? 0;
    value += (byte & 0x7f) * 2 ** (7 * (index - offset));
    if ((byte & 0x80) === 0) {
      return { value, next: index + 1 };
    }
  }
  return undefined;
}

/** Returns the last length-delimited value of `field`, or undefined for malformed input. */
function readBytesField(bytes: Uint8Array, field: number): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key) {
      return undefined;
    }
    offset = key.next;
    const wireType = key.value % 8;
    if (wireType === 0) {
      const skipped = readVarint(bytes, offset);
      if (!skipped) {
        return undefined;
      }
      offset = skipped.next;
    } else if (wireType === 1 || wireType === 5) {
      offset += wireType === 1 ? 8 : 4;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.value > bytes.length - length.next) {
        return undefined;
      }
      offset = length.next + length.value;
      if (Math.floor(key.value / 8) === field) {
        found = bytes.subarray(length.next, offset);
      }
    } else {
      return undefined;
    }
  }
  return offset === bytes.length ? found : undefined;
}

function isProgressUpdateSignature(signature: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }
  const metadata = readBytesField(bytes, 2);
  const block = metadata && readBytesField(metadata, 1);
  const kind = block && readBytesField(block, 8);
  return kind !== undefined && new TextDecoder().decode(kind) === PROGRESS_UPDATE_KIND;
}

/**
 * Converts a completed progress-update thinking block to visible text. The text
 * keeps its signature so replay can return the block to Anthropic unchanged.
 */
export function toAnthropicProgressUpdateText(block: {
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}): TextContent | undefined {
  const signature = block.thinkingSignature;
  if (block.redacted || !signature || !block.thinking.trim()) {
    return undefined;
  }
  return isProgressUpdateSignature(signature)
    ? {
        type: "text",
        text: block.thinking,
        textSignature: JSON.stringify({ v: 1, anthropicProgressUpdate: signature }),
      }
    : undefined;
}

/** Reads the signature a progress-update text block must be replayed with. */
export function readAnthropicProgressUpdateSignature(textSignature: unknown): string | undefined {
  if (typeof textSignature !== "string" || !textSignature.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(textSignature);
    const signature =
      parsed && typeof parsed === "object" && Reflect.get(parsed, "v") === 1
        ? Reflect.get(parsed, "anthropicProgressUpdate")
        : undefined;
    return typeof signature === "string" && signature ? signature : undefined;
  } catch {
    return undefined;
  }
}
