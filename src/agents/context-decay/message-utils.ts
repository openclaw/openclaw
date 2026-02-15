import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Extract text content from a message at the given index.
 * Handles both string content and structured content blocks.
 */
export function extractContentText(msg: AgentMessage): string {
  const msgUnk = msg as unknown as { content: unknown };
  if (typeof msgUnk.content === "string") {
    return msgUnk.content;
  }
  if (!Array.isArray(msgUnk.content)) {
    return JSON.stringify(msgUnk.content);
  }
  return (msgUnk.content as Array<Record<string, unknown>>)
    .filter((b) => b.type === "text")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * Find the tool name and args by looking up the matching tool_use block.
 * Walks backward from the tool result to find the assistant message with the matching tool_use.
 */
export function extractToolInfo(
  messages: AgentMessage[],
  toolResultIndex: number,
): { toolName: string; args: string } {
  const toolResultMsg = messages[toolResultIndex] as unknown as Record<string, unknown>;
  const toolCallId = toolResultMsg.toolCallId as string | undefined;

  if (!toolCallId) {
    return { toolName: "unknown", args: "{}" };
  }

  for (let i = toolResultIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") {
      continue;
    }
    const msgContent = (msg as unknown as { content: unknown }).content;
    if (!Array.isArray(msgContent)) {
      continue;
    }
    for (const block of msgContent) {
      if (block.type === "tool_use" && block.id === toolCallId) {
        return {
          toolName: (block.name as string) ?? "unknown",
          args: JSON.stringify(block.input ?? {}),
        };
      }
    }
  }

  return { toolName: "unknown", args: "{}" };
}
