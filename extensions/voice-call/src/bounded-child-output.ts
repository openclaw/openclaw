import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const DEFAULT_MAX_OUTPUT_CHARS = 16_384;

/** Keep the newest diagnostic text without splitting a surrogate pair. */
export function formatBoundedChildOutput(text: string): string {
  return text.length > DEFAULT_MAX_OUTPUT_CHARS
    ? `[output truncated]\n${sliceUtf16Safe(text, -DEFAULT_MAX_OUTPUT_CHARS)}`
    : text;
}
