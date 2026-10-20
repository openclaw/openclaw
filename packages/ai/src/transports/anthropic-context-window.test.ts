import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  anthropicModel,
  createAnthropicResponse,
} from "../provider-transport-parity.test-support.js";
import { streamAnthropic } from "../providers/anthropic.js";
import type { Context, Model } from "../types.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

const originalHost = getAiTransportHost();

const model: Model<"anthropic-messages"> = {
  ...anthropicModel,
  id: "claude-fable-5",
  name: "Claude Fable 5",
};
const context: Context = {
  messages: [{ role: "user", content: "Finish the answer.", timestamp: 0 }],
};

function contextWindowResponse(): Response {
  return createAnthropicResponse([
    {
      type: "message_start",
      message: {
        id: "msg_context_limit",
        model: model.id,
        usage: { input_tokens: 199_997, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "This answer reached the context window." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "model_context_window_exceeded", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ]);
}

describe("Anthropic context-window completion", () => {
  afterEach(() => configureAiTransportHost(originalHost));

  it.each([
    ["provider", streamAnthropic],
    ["transport", createAnthropicMessagesTransportStreamFn()],
  ] as const)("preserves buffered text, usage, and terminal order through %s", async (_, run) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => contextWindowResponse());
    configureAiTransportHost({ buildModelFetch: () => fetchMock });

    const stream = await run(model, context, { apiKey: "test-key" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(result.stopReason).toBe("length");
    expect(result.content).toEqual([
      { type: "text", text: "This answer reached the context window." },
    ]);
    expect(result.usage).toMatchObject({ input: 199_997, output: 3, totalTokens: 200_000 });
    expect(result.errorMessage).toBeUndefined();
  });
});
