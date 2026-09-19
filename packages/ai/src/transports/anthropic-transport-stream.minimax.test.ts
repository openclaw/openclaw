import type { Model } from "@openclaw/llm-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
const coreTransportHost = getAiTransportHost();
const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);

function sse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeMinimaxM3Model(): Model<"anthropic-messages"> {
  const model = {
    id: "MiniMax-M3",
    name: "MiniMax M3",
    api: "anthropic-messages" as const,
    provider: "minimax",
    baseUrl: "https://api.minimax.io/anthropic",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
  } satisfies Model<"anthropic-messages">;
  return Object.assign(model, {
    [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]: { proxy: { mode: "env-proxy" } },
  });
}

describe("anthropic transport MiniMax-M3 commentary", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    configureAiTransportHost({
      ...coreTransportHost,
      buildModelFetch: () => fetchMock,
    });
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    configureAiTransportHost(coreTransportHost);
  });

  it("tags MiniMax-M3 pre-tool text as commentary when thinking stays in text blocks", async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        {
          type: "message_start",
          message: {
            id: "msg_m3",
            model: "MiniMax-M3",
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "Running through the relevant rules and checking access for this turn.",
          },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool_lookup", name: "lookup", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"query":"value"}' },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 10, output_tokens: 12 },
        },
        { type: "message_stop" },
      ]),
    );

    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        makeMinimaxM3Model(),
        { messages: [{ role: "user", content: "Look up a value and report back.", timestamp: 1 }] },
        { apiKey: "sk-minimax-test" },
      ),
    );
    const result = await stream.result();
    const textBlock = result.content.find((block) => block.type === "text");
    if (textBlock?.type !== "text") {
      throw new Error("expected MiniMax-M3 pre-tool text block");
    }
    expect(JSON.parse(String(textBlock.textSignature))).toMatchObject({
      v: 1,
      id: expect.stringMatching(/^minimax-commentary-0-[0-9a-f]{24}$/),
      phase: "commentary",
    });
    expect(result.content.some((block) => block.type === "toolCall")).toBe(true);
  });
});
