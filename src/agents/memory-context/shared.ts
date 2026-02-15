/**
 * Shared constants and utilities used across multiple memory-context modules.
 * Single source of truth to avoid duplication.
 */

/** Marker for recalled-context injection messages. */
export const RECALLED_CONTEXT_MARKER = '<recalled-context source="memory-context">';

/**
 * Regex to detect channel-injected system prefix lines.
 * Matches:
 *   "System: [2026-02-15 ..."       (gateway system prefix)
 *   "[Sun 2026-02-15 ..."           (day-prefixed format)
 *   "[2026-02-15 18:49:02 GMT+8]"   (direct timestamp, no day name)
 */
export const SYSTEM_PREFIX_RE =
  /^(?:System:\s*)?\[(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+)?\d{4}-\d{2}-\d{2}\s/;

/**
 * Strip channel-injected system event lines and inbound metadata blocks
 * from text to extract the actual user content.
 *
 * Removes:
 * - System event lines: "System: [timestamp] ..." / "[Sun 2026-02-15 ...]"
 * - Inbound metadata blocks: "Conversation info (untrusted metadata):" + JSON
 * - Sender/Channel metadata blocks
 */
export function stripChannelPrefix(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  let inMetadataBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip system event lines
    if (SYSTEM_PREFIX_RE.test(trimmed)) {
      continue;
    }

    // Skip inbound metadata blocks:
    // "Conversation info (untrusted metadata):" / "Sender (untrusted metadata):" etc.
    if (/^(?:Conversation|Sender|Channel)\s.*\(untrusted metadata\):?\s*$/i.test(trimmed)) {
      inMetadataBlock = true;
      continue;
    }

    // Skip JSON blocks inside metadata sections
    if (inMetadataBlock) {
      if (trimmed === "```json" || trimmed === "```") {
        continue;
      }
      if (trimmed.startsWith("{") || trimmed.startsWith("}") || trimmed.startsWith('"')) {
        continue;
      }
      // End of metadata block when we hit a non-JSON, non-empty line
      if (trimmed) {
        inMetadataBlock = false;
      } else {
        continue; // empty line inside metadata
      }
    }

    cleaned.push(line);
  }

  return cleaned.join("\n").trim();
}

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
