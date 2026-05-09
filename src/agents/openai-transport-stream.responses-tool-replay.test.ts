import type { AssistantMessage, Context, Model, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { buildOpenAIResponsesParams } from "./openai-transport-stream.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function buildNativeCodexModel(): Model<"openai-codex-responses"> {
  return {
    id: "gpt-5.5",
    name: "gpt-5.5",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function buildAssistantMessage(params: {
  stopReason: AssistantMessage["stopReason"];
  content: AssistantMessage["content"];
}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage: ZERO_USAGE,
    stopReason: params.stopReason,
    timestamp: 1,
    content: params.content,
  };
}

function buildToolResult(toolCallId: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "lookup",
    content: [{ type: "text", text: "tool output" }],
    isError: false,
    timestamp: 1,
  };
}

function buildParams(messages: Context["messages"]) {
  return buildOpenAIResponsesParams(
    buildNativeCodexModel(),
    {
      systemPrompt: "You are concise.",
      messages,
    },
    { cacheRetention: "none" },
  );
}

function inputItems(params: ReturnType<typeof buildParams>) {
  return Array.isArray(params.input) ? (params.input as Array<Record<string, unknown>>) : [];
}

function inputTypes(params: ReturnType<typeof buildParams>) {
  return inputItems(params).map((item) => item.type);
}

describe("OpenAI Codex Responses tool replay", () => {
  it("does not replay completed function call outputs after the turn was consumed", () => {
    const params = buildParams([
      { role: "user", content: "look something up", timestamp: 1 },
      buildAssistantMessage({
        stopReason: "toolUse",
        content: [
          {
            type: "thinking",
            thinking: "need lookup",
            thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_old", summary: [] }),
          },
          {
            type: "toolCall",
            id: "call_old|fc_old",
            name: "lookup",
            arguments: { query: "example" },
          },
        ],
      }),
      buildToolResult("call_old|fc_old"),
      buildAssistantMessage({
        stopReason: "stop",
        content: [{ type: "text", text: "done", textSignature: "msg_done" }],
      }),
      { role: "user", content: "next turn", timestamp: 1 },
    ]);

    expect(inputTypes(params)).not.toContain("function_call");
    expect(inputTypes(params)).not.toContain("function_call_output");
  });

  it("keeps the active tail function call output for tool continuation", () => {
    const params = buildParams([
      { role: "user", content: "look something up", timestamp: 1 },
      buildAssistantMessage({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_active|fc_active",
            name: "lookup",
            arguments: { query: "example" },
          },
        ],
      }),
      buildToolResult("call_active|fc_active"),
    ]);

    const functionCall = inputItems(params).find((item) => item.type === "function_call");
    const functionCallOutput = inputItems(params).find(
      (item) => item.type === "function_call_output",
    );

    expect(functionCall?.call_id).toBe("call_active");
    expect(functionCallOutput?.call_id).toBe("call_active");
  });
});