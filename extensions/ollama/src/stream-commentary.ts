import { randomUUID } from "node:crypto";
import type { StopReason, TextContent, ThinkingContent, ToolCall } from "openclaw/plugin-sdk/llm";

export function appendOllamaResponseText(
  content: (TextContent | ThinkingContent | ToolCall)[],
  text: string,
  stopReason: StopReason,
): void {
  if (!text) {
    return;
  }
  const block: TextContent = { type: "text", text };
  // Only a completed tool use establishes commentary; length stops remain answers.
  // The v1 signature needs a distinct identity across successive tool rounds.
  if (stopReason === "toolUse" && text.trim()) {
    block.textSignature = JSON.stringify({
      v: 1,
      id: `commentary-${randomUUID()}`,
      phase: "commentary",
    });
  }
  content.push(block);
}
