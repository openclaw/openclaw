import { describe, expect, it } from "vitest";
import type { Message, Model } from "../types.js";
import { transformMessages } from "./transform-messages.js";

const model: Model<"openai-completions"> = {
  id: "text-only-model",
  name: "Text-only model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

describe("transformMessages", () => {
  it("normalizes null or missing content before provider transforms", () => {
    const messages = [
      { role: "user", content: null, timestamp: 1 },
      {
        role: "assistant",
        content: null,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup",
        isError: false,
        timestamp: 3,
      },
    ] as unknown as Message[];

    const transformed = transformMessages(messages, model);

    expect(transformed).toHaveLength(3);
    expect(transformed.map((message) => message.content)).toEqual([[], [], []]);
  });

  it("matches tool results whose call ids contain surrounding whitespace", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: " call_1 ",
        toolName: "lookup",
        content: [{ type: "text", text: "actual result" }],
        isError: false,
        timestamp: 2,
      },
    ] as Message[];

    const transformed = transformMessages(messages, model);

    expect(transformed).toHaveLength(2);
    expect(transformed[0]?.content).toEqual([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
    ]);
    expect(transformed[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "actual result" }],
      isError: false,
    });
  });

  it("keeps trimmed call ids when removing cross-model thought signatures", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: " call_1 ",
            name: "lookup",
            arguments: {},
            thoughtSignature: "provider-bound",
          },
        ],
        api: model.api,
        provider: "other-provider",
        model: "other-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup",
        content: [{ type: "text", text: "actual result" }],
        isError: false,
        timestamp: 2,
      },
    ] as Message[];

    const transformed = transformMessages(messages, model);

    expect(transformed).toHaveLength(2);
    expect(transformed[0]?.content).toEqual([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
    ]);
    expect(transformed[1]).toMatchObject({ role: "toolResult", toolCallId: "call_1" });
  });
});
