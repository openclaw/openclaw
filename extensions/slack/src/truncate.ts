import { truncateWithMarker } from "openclaw/plugin-sdk/string-normalization-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export function truncateSlackText(
  value: string,
  max: number,
  whitespace: "trim" | "preserve" = "trim",
): string {
  const text = whitespace === "preserve" ? value : value.trim();
  if (text.length <= max) {
    return text;
  }
  if (max <= 1) {
    return sliceUtf16Safe(text, 0, max);
  }
  return truncateWithMarker(text, max, { marker: "…", reserve: 1, trimEnd: false });
}

export function countSlackTextUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate Slack text without splitting a code point or exceeding a UTF-8 byte limit. */
export function truncateSlackTextByUtf8Bytes(value: string, maxBytes: number): string {
  const trimmed = value.trim();
  if (maxBytes <= 0) {
    return "";
  }
  if (countSlackTextUtf8Bytes(trimmed) <= maxBytes) {
    return trimmed;
  }

  const suffix = "…";
  const suffixBytes = countSlackTextUtf8Bytes(suffix);
  const prefixBudget = maxBytes >= suffixBytes ? maxBytes - suffixBytes : maxBytes;
  let prefix = "";
  let prefixBytes = 0;
  for (const character of trimmed) {
    const characterBytes = countSlackTextUtf8Bytes(character);
    if (prefixBytes + characterBytes > prefixBudget) {
      break;
    }
    prefix += character;
    prefixBytes += characterBytes;
  }
  return maxBytes >= suffixBytes ? `${prefix}${suffix}` : prefix;
}
