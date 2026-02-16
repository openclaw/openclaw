import type { AssistantMessage, Model, ToolResultMessage } from "@mariozechner/pi-ai";
import { streamOpenAIResponses } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

function buildModel(): Model<"openai-responses"> {
  return {
    id: "gpt-5.2",
    name: "gpt-5.2",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function extractInputTypes(payload: Record<string, unknown> | undefined) {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  return input
    .map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>).type : undefined,
    )
    .filter((t): t is string => typeof t === "string");
}

async function runAbortedOpenAIResponsesStream(params: {
  messages: Array<
    AssistantMessage | ToolResultMessage | { role: "user"; content: string; timestamp: number }
  >;
  tools?: Array<{
    name: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
  }>;
}) {
  const controller = new AbortController();
  controller.abort();
  let payload: Record<string, unknown> | undefined;

  const stream = streamOpenAIResponses(
    buildModel(),
    {
      systemPrompt: "system",
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
    },
    {
      apiKey: "test",
      signal: controller.signal,
      onPayload: (nextPayload) => {
        payload = nextPayload as Record<string, unknown>;
      },
    },
  );

  await stream.result();
  return extractInputTypes(payload);
}

describe("openai-responses reasoning replay", () => {
  it("replays reasoning for tool-call-only turns (OpenAI requires it)", async () => {
    const assistantToolOnly: AssistantMessage = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
      content: [
        {
          type: "thinking",
          thinking: "internal",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_test",
            summary: [],
          }),
        },
        {
          type: "toolCall",
          id: "call_123|fc_123",
          name: "noop",
          arguments: {},
        },
      ],
    };

    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_123|fc_123",
      toolName: "noop",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    };

    const types = await runAbortedOpenAIResponsesStream({
      messages: [
        {
          role: "user",
          content: "Call noop.",
          timestamp: Date.now(),
        },
        assistantToolOnly,
        toolResult,
        {
          role: "user",
          content: "Now reply with ok.",
          timestamp: Date.now(),
        },
      ],
      tools: [
        {
          name: "noop",
          description: "no-op",
          parameters: Type.Object({}, { additionalProperties: false }),
        },
      ],
    });

    expect(types).toContain("reasoning");
    expect(types).toContain("function_call");
    expect(types.indexOf("reasoning")).toBeLessThan(types.indexOf("function_call"));

    const functionCall = input.find(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "function_call",
    ) as Record<string, unknown> | undefined;
    expect(functionCall?.call_id).toBe("call_123");
    expect(functionCall?.id).toBe("fc_123");
  });

  it("still replays reasoning when paired with an assistant message", async () => {
    const assistantWithText: AssistantMessage = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
      content: [
        {
          type: "thinking",
          thinking: "internal",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_test",
            summary: [],
          }),
        },
        { type: "text", text: "hello", textSignature: "msg_test" },
      ],
    };

    const types = await runAbortedOpenAIResponsesStream({
      messages: [
        { role: "user", content: "Hi", timestamp: Date.now() },
        assistantWithText,
        { role: "user", content: "Ok", timestamp: Date.now() },
      ],
    });

    expect(types).toContain("reasoning");
    expect(types).toContain("message");
  });
});
