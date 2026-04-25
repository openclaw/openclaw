import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-transport-stream.js";

const CAPTURE_ABORT_MESSAGE = "__payload_capture_abort__";

async function collectStreamEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function buildCodexResponsesModel(): Model<"openai-codex-responses"> {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

function buildCompletionsModel(): Model<"openai-completions"> {
  return {
    id: "doubao-seed-2-0-lite-260215",
    name: "Doubao Seed 2.0 Lite",
    api: "openai-completions",
    provider: "volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

describe("openai transport stream payload capture", () => {
  it("captures HTTP previous_response_id continuations for codex responses", async () => {
    const streamFn = createOpenAIResponsesTransportStreamFn();
    const model = buildCodexResponsesModel();
    let capturedPayload: Record<string, unknown> | undefined;

    const stream = await streamFn(
      model,
      {
        systemPrompt: "system",
        tools: [],
        messages: [
          {
            role: "user",
            content: "Check the weather.",
            timestamp: 1,
          },
          {
            role: "assistant",
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.4",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2,
            responseId: "resp_tool_turn",
            content: [
              {
                type: "toolCall",
                id: "call_weather|fc_weather",
                name: "get_weather",
                arguments: { city: "Taipei" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_weather|fc_weather",
            toolName: "get_weather",
            content: [{ type: "text", text: "Sunny, 70F." }],
            isError: false,
            timestamp: 3,
          },
        ],
      } as never,
      {
        apiKey: "test",
        onPayload: async (payload: unknown) => {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error(CAPTURE_ABORT_MESSAGE);
        },
      } as never,
    );

    const events = await collectStreamEvents(stream);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          errorMessage: CAPTURE_ABORT_MESSAGE,
        }),
      }),
    );
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.previous_response_id).toBe("resp_tool_turn");
    expect(capturedPayload?.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_weather",
        output: "Sunny, 70F.",
      },
    ]);
  });

  it("captures encrypted_content replay on OpenAI-compatible completions continuations", async () => {
    const streamFn = createOpenAICompletionsTransportStreamFn();
    const model = buildCompletionsModel();
    let capturedPayload: Record<string, unknown> | undefined;

    const stream = await streamFn(
      model,
      {
        systemPrompt: "system",
        tools: [],
        messages: [
          {
            role: "user",
            content: "今天北京天气怎么样",
            timestamp: 1,
          },
          {
            role: "assistant",
            api: "openai-completions",
            provider: "volcengine",
            model: "doubao-seed-2-0-lite-260215",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2,
            content: [
              {
                type: "thinking",
                thinking: "北京天气查询将由我调用相关工具完成。",
                thinkingSignature: JSON.stringify({
                  v: 1,
                  type: "openai-completions-reasoning",
                  field: "reasoning_content",
                  content: "北京天气查询将由我调用相关工具完成。",
                  encrypted_content: "enc_blob",
                }),
              },
              {
                type: "toolCall",
                id: "call_weather",
                name: "get_weather",
                arguments: { city: "北京" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_weather",
            toolName: "get_weather",
            content: [{ type: "text", text: "5度" }],
            isError: false,
            timestamp: 3,
          },
        ],
      } as never,
      {
        apiKey: "test",
        onPayload: async (payload: unknown) => {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error(CAPTURE_ABORT_MESSAGE);
        },
      } as never,
    );

    const events = await collectStreamEvents(stream);
    const messages = (capturedPayload?.messages ?? []) as Array<Record<string, unknown>>;
    const assistantMessage = messages.find((message) => message.role === "assistant");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          errorMessage: CAPTURE_ABORT_MESSAGE,
        }),
      }),
    );
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      reasoning_content: "北京天气查询将由我调用相关工具完成。",
      encrypted_content: "enc_blob",
    });
  });
});
