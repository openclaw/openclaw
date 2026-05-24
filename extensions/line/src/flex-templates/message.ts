import type { messagingApi } from "@line/bot-sdk";
import type { FlexContainer } from "./types.js";

/**
 * Truncate a string to a maximum number of Unicode characters (code points),
 * ensuring multi-byte characters (emoji, CJK) are never broken.
 * Appends "…" (U+2026) if truncation occurs.
 */
function truncateToChars(str: string, maxChars: number): string {
  const chars = Array.from(str);
  if (chars.length <= maxChars) {
    return str;
  }
  // Keep maxChars - 1 characters, then append ellipsis
  return chars.slice(0, maxChars - 1).join("") + "…";
}

/**
 * Wrap a FlexContainer in a FlexMessage
 * altText is truncated to 400 Unicode characters (LINE requirement).
 */
export function toFlexMessage(altText: string, contents: FlexContainer): messagingApi.FlexMessage {
  const truncated = truncateToChars(altText, 400);
  return {
    type: "flex",
    altText: truncated,
    contents,
  };
}
