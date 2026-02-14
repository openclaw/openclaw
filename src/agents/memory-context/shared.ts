/**
 * Shared constants and utilities used across multiple memory-context modules.
 * Single source of truth to avoid duplication.
 */

/** Marker for recalled-context injection messages. */
export const RECALLED_CONTEXT_MARKER = '<recalled-context source="memory-context">';

/**
 * Extract text content from a message-like object.
 * Handles both string content and array-of-blocks content.
 */
export function extractText(msg: { content?: unknown }): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
  }
  return "";
}
