// Anthropic provider tests for completed-turn thinking replay in the request payload.
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { streamAnthropic } from "./anthropic.js";

function user(content: string, timestamp = 0): Context["messages"][number] {
  return { role: "user", content, timestamp };
}
function conversation(...messages: Context["messages"]): Context {
  return { messages };
}
function thinking(
  text: string,
  thinkingSignature: string,
): Extract<AssistantMessage["content"][number], { type: "thinking" }> {
  return { type: "thinking", thinking: text, thinkingSignature };
}

function makeAnthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
}

function makeAnthropicAssistantMessage(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-sonnet-4-6",
    stopReason: "stop",
    timestamp: 0,
    usage: createZeroUsage(),
    content,
    ...overrides,
  };
}

function wireMessages(payload: Record<string, unknown>) {
  return payload.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
}
function assistantContent(payload: Record<string, unknown>) {
  return wireMessages(payload).find((message) => message.role === "assistant")?.content;
}

async function captureRawAnthropicPayload(
  model: Partial<Model<"anthropic-messages">>,
  options: { apiKey?: string },
  context: Context,
) {
  let capturedPayload: unknown;
  const stream = streamAnthropic(makeAnthropicModel(model), context, {
    apiKey: "sk-ant-provider",
    ...options,
    onPayload: (payload: unknown) => {
      capturedPayload = payload;
      throw new Error("stop before network");
    },
  });
  await stream.result();
  return { payload: capturedPayload as Record<string, unknown> };
}

describe("Anthropic provider thinking replay", () => {
  it("omits completed-turn thinking when no thinking mode is requested", async () => {
    const { payload } = await captureRawAnthropicPayload(
      {},
      {},
      conversation(
        user("hello"),
        makeAnthropicAssistantMessage([
          thinking("private reasoning", "sig_1"),
          {
            type: "thinking",
            thinking: "[Reasoning redacted]",
            thinkingSignature: "opaque_1",
            redacted: true,
          },
        ]),
        user("again"),
      ),
    );
    expect(payload.thinking).toBeUndefined();
    expect(assistantContent(payload)).toEqual([
      { type: "text", text: "[assistant reasoning omitted]", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("strips Fable thinking when replay targets Anthropic Vertex", async () => {
    const { payload } = await captureRawAnthropicPayload(
      { provider: "anthropic-vertex", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { apiKey: "vertex-token" },
      conversation(
        user("hello"),
        makeAnthropicAssistantMessage(
          [
            thinking("model-bound thought", "sig_model_bound"),
            { type: "text", text: "visible answer" },
          ],
          { model: "claude-fable-5" },
        ),
        user("continue"),
      ),
    );
    const assistant = wireMessages(payload).find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "text", text: "visible answer", cache_control: { type: "ephemeral" } },
    ]);
    expect(JSON.stringify(assistant)).not.toContain("sig_model_bound");
  });
});
