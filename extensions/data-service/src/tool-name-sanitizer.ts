/**
 * Tool Name Sanitizer for Bedrock Converse API compatibility.
 *
 * Some models (e.g., Qwen-based models on Bedrock like `openai.gpt-oss-20b-1`)
 * emit special tokens in tool call names, e.g.:
 *   "fs_list<|channel|>commentary"  →  should be "fs_list"
 *   "connector_actions<|channel|>json"  →  should be "connector_actions"
 *
 * The Bedrock Converse API requires tool names to match [a-zA-Z0-9_-]+.
 * When corrupted names end up in the session history, subsequent LLM calls fail
 * with: "Value at '…toolUse.name' failed to satisfy constraint".
 *
 * This module provides sanitization at two levels:
 * 1. `sanitizeToolNamesInMessages()` — cleans the entire message history in-place
 *    before each LLM call (via `before_agent_start` hook).
 * 2. `sanitizeToolNameInMessage()` — cleans a single message being persisted
 *    (via `tool_result_persist` hook) to prevent corruption from being stored.
 */

/** Matches special tokens like <|channel|>, <|endoftext|>, <|im_end|>, etc. */
const SPECIAL_TOKEN_RE = /<\|[^|>]+\|>/g;

/** Bedrock-valid tool name pattern: only [a-zA-Z0-9_-]+ */
const VALID_TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Test whether a tool name is valid for the Bedrock Converse API.
 */
export function isValidToolName(name: string): boolean {
  return VALID_TOOL_NAME_RE.test(name);
}

/**
 * Sanitize a single tool name by stripping special tokens and any trailing
 * format hints that follow them.
 *
 * Examples:
 *   "fs_list<|channel|>commentary"  →  "fs_list"
 *   "connector_actions<|channel|>json"  →  "connector_actions"
 *   "exec<|im_end|>"  →  "exec"
 */
export function sanitizeToolName(name: string): string {
  // Truncate at the first special token — everything before it is the real name
  const firstTokenIdx = name.search(SPECIAL_TOKEN_RE);
  if (firstTokenIdx > 0) {
    return name.slice(0, firstTokenIdx).trim();
  }
  // Fallback: strip all special tokens and any residual whitespace
  const cleaned = name.replace(SPECIAL_TOKEN_RE, "").trim();
  return cleaned || name;
}

// -- Content block type guards ------------------------------------------------

type ToolCallBlock = { type: string; name?: string };

function isToolCallBlock(block: unknown): block is ToolCallBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as { type?: string };
  return b.type === "toolCall" || b.type === "toolUse";
}

// -- Message-level sanitization -----------------------------------------------

/**
 * Sanitize tool call names in a single message's content blocks.
 * Mutates the blocks in-place. Returns the count of names fixed.
 */
function sanitizeContentBlocks(content: unknown[]): number {
  let fixed = 0;
  for (const block of content) {
    if (!isToolCallBlock(block)) continue;
    const b = block as ToolCallBlock;
    if (typeof b.name === "string" && !isValidToolName(b.name)) {
      const original = b.name;
      b.name = sanitizeToolName(b.name);
      if (b.name !== original) {
        console.log(`[data-service] sanitized tool name: "${original}" -> "${b.name}"`);
        fixed++;
      }
    }
  }
  return fixed;
}

/**
 * Walk the full message history and sanitize any tool names in assistant
 * message toolCall/toolUse blocks that contain invalid characters.
 *
 * Mutates messages **in-place** so the cleaned names are what the LLM
 * provider receives. Called from the `before_agent_start` hook.
 */
export function sanitizeToolNamesInMessages(messages: unknown[] | undefined): void {
  if (!messages || !Array.isArray(messages)) return;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const { role, content } = msg as { role?: string; content?: unknown };
    if (role !== "assistant" || !Array.isArray(content)) continue;
    sanitizeContentBlocks(content);
  }
}

/**
 * Sanitize tool call names in a single message about to be persisted.
 * Returns a new message object if any names were fixed, or the original
 * message if nothing changed.
 *
 * Called from the `tool_result_persist` hook. Although this hook primarily
 * targets toolResult messages, we also accept assistant messages so the
 * function can be reused.
 */
export function sanitizeToolNameInMessage<T extends Record<string, unknown>>(message: T): T {
  const content = message.content;
  if (!Array.isArray(content)) return message;
  const fixed = sanitizeContentBlocks(content);
  // Content blocks are mutated in-place; return the same reference
  return fixed > 0 ? { ...message } : message;
}
