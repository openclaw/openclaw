import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, Model } from "../types.js";
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

function sonnet5Model(provider: string): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "anthropic-messages",
    provider,
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

function signedThinkingAssistantMessage(provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "internal reasoning",
        thinkingSignature: "sig-bound-to-issuer",
      },
      { type: "text", text: "final answer" },
    ],
    api: "anthropic-messages",
    provider,
    model: "claude-sonnet-5",
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
  } as AssistantMessage;
}

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

  it("keeps signed thinking when replaying to the same provider route", () => {
    const [transformed] = transformMessages(
      [signedThinkingAssistantMessage("anthropic")],
      sonnet5Model("anthropic"),
    );

    expect(transformed?.content).toEqual([
      {
        type: "thinking",
        thinking: "internal reasoning",
        thinkingSignature: "sig-bound-to-issuer",
      },
      { type: "text", text: "final answer" },
    ]);
  });

  // Regression: signed thinking from one platform was preserved verbatim when
  // the session switched to a different provider serving the same Claude
  // identity; the foreign platform rejects the signature on every turn.
  it("drops signed thinking when replaying to a different provider", () => {
    const [transformed] = transformMessages(
      [signedThinkingAssistantMessage("anthropic")],
      sonnet5Model("amazon-bedrock-mantle"),
    );

    expect(transformed?.content).toEqual([{ type: "text", text: "final answer" }]);
  });
});
