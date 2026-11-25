import { afterEach, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamAnthropic } from "../providers/anthropic.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { frame, serializeSse } from "../providers/provider-stream.test-support.js";
import type { Context, Model } from "../types.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

const initialHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(initialHost));

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
const model: Model<"anthropic-messages"> = {
  ...makeProviderModel("anthropic-messages", "anthropic", "claude-fable-5-2", {
    baseUrl: "https://provider.test",
  }),
  maxTokens: 8192,
};

it.each([
  ["SDK", streamAnthropic],
  ["transport", createAnthropicMessagesTransportStreamFn()],
] as const)(
  "names the output cap when max_tokens cuts a tool call (%s, #196544)",
  async (_, stream) => {
    const body = serializeSse([
      frame("message_start", {
        message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
      }),
      frame("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "write", input: {} },
      }),
      frame("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"a":' },
      }),
      frame("message_delta", {
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 8192 },
      }),
      frame("message_stop", {}),
    ]);
    configureAiTransportHost({
      buildModelFetch: () => async () =>
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    const result = await (await stream(model, context, { apiKey: "fixture-token" })).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "Provider completed stream with an incomplete tool call: output token limit reached (max_tokens 8192); raise the model's maxTokens",
    );
  },
);
