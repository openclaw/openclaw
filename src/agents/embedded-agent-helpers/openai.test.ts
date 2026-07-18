// Covers OpenAI Responses tool-call id normalization for replay safety.
import type { AssistantMessage, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { normalizeOpenAIResponsesToolCallIds } from "./openai.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function buildAssistantToolCall(rawId: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openrouter",
    model: "moonshotai/kimi-k2.5",
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: 0,
    content: [{ type: "toolCall", id: rawId, name: "gateway", arguments: {} }],
  };
}

function buildToolResult(rawId: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: rawId,
    toolName: "gateway",
    content: [],
    isError: false,
    timestamp: 0,
  };
}

function toolCallId(message: AgentMessage): string {
  const content = (message as { content?: Array<{ type?: unknown; id?: unknown }> }).content;
  const call = content?.find((block) => block.type === "toolCall");
  return call?.id as string;
}

function toolResultId(message: AgentMessage): string {
  return (message as { toolCallId?: string }).toolCallId as string;
}

describe("normalizeOpenAIResponsesToolCallIds", () => {
  it("assigns distinct call ids to repeated native Kimi tool calls that share a callId", () => {
    // Native Kimi ids pair a stable `functions.<tool>:<index>` callId with a
    // unique `fc_tmp_*` itemId. The same tool called at the same index across
    // turns (e.g. `gateway` called first every time) previously collided
    // because only the callId half was hashed, producing identical `call_*`
    // ids and breaking Responses replay with dangling_tool_call.
    const messages: AgentMessage[] = [
      buildAssistantToolCall("functions.gateway:0|fc_tmp_kegospxl46"),
      buildToolResult("functions.gateway:0|fc_tmp_kegospxl46"),
      buildAssistantToolCall("functions.gateway:0|fc_tmp_btw21n10glg"),
      buildToolResult("functions.gateway:0|fc_tmp_btw21n10glg"),
    ];

    const [firstCall, firstResult, secondCall, secondResult] = normalizeOpenAIResponsesToolCallIds(
      messages,
    ) as [AgentMessage, AgentMessage, AgentMessage, AgentMessage];

    const firstCallId = toolCallId(firstCall);
    const secondCallId = toolCallId(secondCall);
    expect(firstCallId).not.toBe(secondCallId);
    expect(toolResultId(firstResult)).toBe(firstCallId);
    expect(toolResultId(secondResult)).toBe(secondCallId);
  });
});
