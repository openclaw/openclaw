import { randomUUID } from "node:crypto";
import type { StopReason, TextContent, ThinkingContent, ToolCall } from "openclaw/plugin-sdk/llm";

/**
 * Tags unphased visible text as pre-tool commentary (v1 signature) before it can
 * be classified as a final answer. Native Ollama returns narration and tool calls
 * in the same assistant message, and that narration is not the reply. Mirrors the
 * Chat Completions and Anthropic transports (packages/ai/src/utils/assistant-text-phase.ts)
 * so the default channel keeps it out of the reply lane.
 */
function tagPendingCommentaryText(
  content: ReadonlyArray<TextContent | ThinkingContent | ToolCall>,
): void {
  let commentaryIndex = content.filter(
    (block): block is TextContent => block.type === "text" && block.textSignature !== undefined,
  ).length;
  for (const block of content) {
    if (
      block.type !== "text" ||
      block.text.trim().length === 0 ||
      block.textSignature !== undefined
    ) {
      continue;
    }
    // A response-local index alone aliases each segment across responses (every
    // response's first commentary becomes `commentary-0`) and collapses distinct
    // stream-reconciliation rows in the UI. Add per-segment entropy so the
    // generated identity stays unique, matching packages/ai/src/utils/assistant-text-phase.ts.
    block.textSignature = JSON.stringify({
      v: 1,
      id: `commentary-${commentaryIndex}-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      phase: "commentary",
    });
    commentaryIndex += 1;
  }
}

export function appendOllamaResponseText(
  content: (TextContent | ThinkingContent | ToolCall)[],
  text: string,
  stopReason: StopReason,
): void {
  if (text) {
    content.push({ type: "text", text });
  }

  // Text that accompanies a tool call in the same assistant message is pre-tool
  // narration. A token-limit stop is not a tool use, so it stays an ordinary
  // (untagged) partial answer and still reaches the channel.
  if (stopReason === "toolUse") {
    tagPendingCommentaryText(content);
  }
}
