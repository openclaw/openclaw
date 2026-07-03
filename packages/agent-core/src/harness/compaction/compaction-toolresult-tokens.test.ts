import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import { estimateTokens } from "./compaction.js";

const TOOL_OUTPUT = "x".repeat(4000);

// The codex app-server runtime persists tool results as a nested "toolResult"
// content block carrying the payload in both `text` and `content` (see
// extensions/codex/src/app-server/event-projector.ts#createToolResultMessage),
// rather than as a plain "text" block.
function codexToolResult(timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "exec",
    isError: false,
    content: [
      {
        type: "toolResult",
        id: "call-1",
        name: "exec",
        toolName: "exec",
        toolCallId: "call-1",
        content: TOOL_OUTPUT,
        text: TOOL_OUTPUT,
      },
    ],
    timestamp,
  } as unknown as AgentMessage;
}

function userText(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

describe("estimateTokens tool-result accounting", () => {
  it("counts nested toolResult block payloads instead of estimating zero", () => {
    // Regression for #99375: nested "toolResult" blocks used to be ignored by
    // the char counter, so tool-heavy sessions estimated ~0 tokens and the
    // compaction cut point collapsed to the first message (permanent no-op).
    const tokens = estimateTokens(codexToolResult(1));

    expect(tokens).toBeGreaterThan(0);
    // Payload lives in both `text` and `content`; it must be counted once, so
    // the estimate matches an equivalent plain-text message rather than double.
    expect(tokens).toBe(estimateTokens(userText(TOOL_OUTPUT, 1)));
  });
});
