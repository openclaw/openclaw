import type { MorphCompactMessage } from "./types.js";

const MAX_TOOL_RESULT_CHARS = 2000;

/**
 * Extract text from a message content field.
 * Content can be a plain string or an array of content blocks.
 */
function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown> | undefined;
    const type = rec?.type;

    if (type === "text" && typeof rec?.text === "string") {
      parts.push(rec.text);
    } else if (type === "toolUse" || type === "toolCall" || type === "functionCall") {
      const name = typeof rec?.name === "string" ? rec.name : "unknown";
      const input = rec?.input ?? rec?.arguments;
      const inputStr = typeof input === "string" ? input : safeJsonStringify(input);
      parts.push(`[Tool: ${name}] ${inputStr}`);
    } else if (type === "toolResult") {
      const id = typeof rec?.toolCallId === "string" ? rec.toolCallId : "unknown";
      const resultContent = rec?.content;
      const resultText =
        typeof resultContent === "string" ? resultContent : extractContentText(resultContent);
      const truncated =
        resultText.length > MAX_TOOL_RESULT_CHARS
          ? `${resultText.slice(0, MAX_TOOL_RESULT_CHARS)}...`
          : resultText;
      parts.push(`[Tool Result: ${id}] ${truncated}`);
    }
    // Skip image, document, and other non-text block types
  }
  return parts.join("\n");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Map a message role to a Morph-compatible role.
 * Morph only accepts "user" and "assistant".
 * toolResult messages are mapped to "user" (tool results are user-side in the Anthropic protocol).
 */
function mapRole(role: string): "user" | "assistant" {
  if (role === "assistant") {
    return "assistant";
  }
  // "user", "toolResult", and any other role map to "user"
  return "user";
}

/**
 * Strip toolResult details from messages to avoid leaking
 * untrusted/verbose payloads into the compaction API.
 */
function stripToolResultDetails(messages: unknown[]): unknown[] {
  let touched = false;
  const out: unknown[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || (msg as { role?: unknown }).role !== "toolResult") {
      out.push(msg);
      continue;
    }
    const rec = msg as Record<string, unknown>;
    if ("details" in rec) {
      const { details: _, ...rest } = rec;
      out.push(rest);
      touched = true;
    } else {
      out.push(msg);
    }
  }
  return touched ? out : messages;
}

/**
 * Serialize messages to Morph's compact message format.
 *
 * Accepts unknown[] (as provided by the plugin compaction API)
 * and extracts role/content from each message object.
 */
export function serializeForMorph(messages: unknown[]): MorphCompactMessage[] {
  // Strip toolResult details before serialization (security: untrusted payloads)
  const safeMessages = stripToolResultDetails(messages);

  const result: MorphCompactMessage[] = [];
  for (const msg of safeMessages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const rawRole = (msg as { role?: string } | undefined)?.role ?? "user";
    const role = mapRole(rawRole);
    let content = extractContentText((msg as { content?: unknown } | undefined)?.content);
    // Truncate top-level toolResult messages (extractContentText only truncates
    // nested toolResult content blocks, not plain string content at message level)
    if (rawRole === "toolResult" && content.length > MAX_TOOL_RESULT_CHARS) {
      content = `${content.slice(0, MAX_TOOL_RESULT_CHARS)}...`;
    }
    if (!content.trim()) {
      continue;
    }
    result.push({ role, content });
  }

  // Morph API expects alternating roles; merge consecutive same-role messages
  return mergeConsecutiveSameRole(result);
}

/**
 * Merge consecutive messages with the same role into a single message.
 * Morph's API (like many chat APIs) expects alternating user/assistant turns.
 */
function mergeConsecutiveSameRole(messages: MorphCompactMessage[]): MorphCompactMessage[] {
  if (messages.length <= 1) {
    return messages;
  }
  const merged: MorphCompactMessage[] = [];
  let current = messages[0];

  for (let i = 1; i < messages.length; i += 1) {
    const next = messages[i];
    if (next.role === current.role) {
      current = { role: current.role, content: `${current.content}\n\n${next.content}` };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}
