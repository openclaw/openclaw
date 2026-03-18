import fs from "node:fs/promises";
import type { NormalizedTurn } from "./types.js";

// Roles that represent conversational content worth capturing.
const CONTENT_ROLES = new Set(["user", "assistant"]);

// Prefixes / exact strings that signal a no-op reply (should not be flushed).
const NO_REPLY_PATTERN = /^\s*NO_REPLY\s*$/i;

/**
 * Extract readable text from a message `content` field.
 * Handles:
 *   - plain string  (legacy and most common)
 *   - array of content parts ({ type: "text", text: "..." } or { type: "text_delta", text: "..." })
 *
 * Non-text parts (tool_use, tool_result, image, etc.) are silently skipped.
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const type = typeof p.type === "string" ? p.type : "";
      if (type === "text" || type === "text_delta") {
        if (typeof p.text === "string" && p.text) parts.push(p.text);
      }
      // Skip: tool_use, tool_result, image, thinking, redacted_thinking, etc.
    }
    return parts.join("\n").trim();
  }

  return "";
}

/**
 * Returns true for entries that are noise and should NOT be sent to OpenViking:
 *   - tool calls / tool results
 *   - system messages
 *   - thinking / reflection blocks
 *   - binary / media-only content with no text
 *   - NO_REPLY placeholder responses
 */
function isNoiseTurn(role: string, text: string): boolean {
  if (!CONTENT_ROLES.has(role)) return true;
  if (!text.trim()) return true; // empty after extraction → skip
  if (NO_REPLY_PATTERN.test(text)) return true;
  return false;
}

/**
 * Parse a raw JSONL session file and return a flat list of normalized turns.
 * Lines that fail JSON parse or lack the expected shape are silently skipped.
 */
export async function readTranscriptFile(sessionFile: string): Promise<NormalizedTurn[]> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionFile, "utf-8");
  } catch {
    // File not yet created or already archived.
    return [];
  }

  const turns: NormalizedTurn[] = [];
  let index = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Transcripts store conversational entries as { type: "message", message: { role, content } }
    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "";
    const text = extractTextFromContent(msg.content);

    if (isNoiseTurn(role, text)) continue;

    turns.push({
      index,
      role: role as "user" | "assistant",
      text: text.trim(),
    });
    index++;
  }

  return turns;
}
