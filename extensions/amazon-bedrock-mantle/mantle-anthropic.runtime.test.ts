import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  AnthropicConstructor: vi.fn(function MockAnthropic(options: unknown) {
    return { options };
  }),
  streamAnthropic: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: mocks.AnthropicConstructor,
}));

vi.mock("@mariozechner/pi-ai/anthropic", () => ({
  streamAnthropic: mocks.streamAnthropic,
}));

import { createMantleAnthropicStreamFn } from "./mantle-anthropic.runtime.js";

function createTestModel(): Model<Api> {
  return {
    id: "anthropic.claude-opus-4-7",
    name: "Claude Opus 4.7",
    provider: "amazon-bedrock-mantle",
    api: "anthropic-messages",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    headers: {
      "X-Test": "model-header",
    },
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } as Model<Api>;
}

describe("createMantleAnthropicStreamFn", () => {
  it("uses authToken bearer auth for Mantle Anthropic requests", () => {
    const stream = { kind: "anthropic-stream" };
    const model = createTestModel();
    const context = { messages: [] };
    mocks.streamAnthropic.mockReturnValue(stream);

    const result = createMantleAnthropicStreamFn()(model, context, {
      apiKey: "bedrock-bearer-token",
      headers: {
        "X-Caller": "caller-header",
      },
    });

    expect(result).toBe(stream);
    expect(mocks.AnthropicConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: null,
        authToken: "bedrock-bearer-token",
        baseURL: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
        defaultHeaders: expect.objectContaining({
          accept: "application/json",
          "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
          "X-Test": "model-header",
          "X-Caller": "caller-header",
        }),
      }),
    );
    expect(mocks.streamAnthropic).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        client: expect.objectContaining({
          options: expect.objectContaining({
            authToken: "bedrock-bearer-token",
          }),
        }),
        thinkingEnabled: false,
      }),
    );
  });

  it("omits unsupported Opus 4.7 sampling and reasoning overrides", () => {
    const model = createTestModel();
    const context = { messages: [] };
    mocks.streamAnthropic.mockReturnValue({ kind: "anthropic-stream" });

    void createMantleAnthropicStreamFn()(model, context, {
      apiKey: "bedrock-bearer-token",
      temperature: 0.2,
      reasoning: "high",
    });

    expect(mocks.streamAnthropic).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        temperature: undefined,
        thinkingEnabled: false,
      }),
    );
  });
});
