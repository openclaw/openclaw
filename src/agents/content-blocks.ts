/**
 * Anthropic server-side tool block types (executed by Anthropic, not by the client).
 * These should be preserved when processing assistant message content; do not
 * treat them as client tool calls (no toolResult pairing needed).
 */
export const ANTHROPIC_SERVER_CONTENT_BLOCK_TYPES = [
  "server_tool_use",
  "web_search_tool_result",
  "code_execution_tool_result",
] as const;

export type AnthropicServerContentBlockType = (typeof ANTHROPIC_SERVER_CONTENT_BLOCK_TYPES)[number];

export function isAnthropicServerContentBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return (
    typeof type === "string" &&
    (ANTHROPIC_SERVER_CONTENT_BLOCK_TYPES as readonly string[]).includes(type)
  );
}

/**
 * Check if a tool_use block was invoked programmatically (from code execution).
 * PTC tool calls have a `caller` field with `type` starting with "code_execution_".
 */
export function isProgrammaticToolCall(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const b = block as Record<string, unknown>;
  if (b.type !== "tool_use") {
    return false;
  }
  const caller = b.caller as Record<string, unknown> | undefined;
  return typeof caller?.type === "string" && caller.type.startsWith("code_execution_");
}

/**
 * Extract stdout/stderr/returnCode from a code_execution_tool_result block.
 * Returns null if the block is not a valid code_execution_tool_result.
 */
export function extractCodeExecutionResult(block: unknown): {
  stdout: string;
  stderr: string;
  returnCode: number;
} | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const b = block as Record<string, unknown>;
  if (b.type !== "code_execution_tool_result") {
    return null;
  }
  const content = b.content as Record<string, unknown> | undefined;
  if (content?.type !== "code_execution_result") {
    return null;
  }
  return {
    stdout: (content.stdout as string) ?? "",
    stderr: (content.stderr as string) ?? "",
    returnCode: (content.return_code as number) ?? 0,
  };
}

export function collectTextContentBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  return parts;
}
