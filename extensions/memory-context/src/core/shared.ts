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
 * Returns true if the content (after stripping channel prefixes) is noise
 * that should not be stored or indexed for recall.
 *
 * Noise categories:
 *   - HEARTBEAT template prompts & HEARTBEAT_OK responses
 *   - NO_REPLY markers
 *   - Raw audio metadata ("[Audio] ... file_key")
 *   - Queued message notifications
 *   - Content too short (≤ 6 chars) to be useful recall context
 */
export function isNoiseSegment(content: string): boolean {
  const t = content.trim();
  if (!t) return true;

  // Too short to be useful for recall (emoji, single char, etc.)
  if (t.length <= 6) return true;

  // Exact markers
  if (t === "NO_REPLY" || t === "HEARTBEAT_OK") return true;

  // HEARTBEAT template prompt (contains the instruction boilerplate)
  if (t.includes("HEARTBEAT") && t.includes("HEARTBEAT.md")) return true;

  // Raw audio metadata: "[Audio]\n...file_key..."
  if (t.startsWith("[Audio]") && t.includes("file_key")) return true;

  // Queued messages notification
  if (t.startsWith("[Queued messages]")) return true;

  return false;
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
