import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createAnthropicMessagesTransportStreamFn } from "../transports/anthropic-transport-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { Context, Model } from "../types.js";
import { streamAnthropic } from "./anthropic.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { makeProviderModel } from "./provider-model.test-support.js";

const initialHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(initialHost));

const context: Context = {
  messages: [{ role: "user", content: "Hello", timestamp: 1 }],
};
const model = makeProviderModel("openai-completions", "openai", "gpt-5.6-luna", {
  baseUrl: "https://provider.test/v1",
});
const anthropic: Model<"anthropic-messages"> = {
  ...model,
  id: "sonnet-4.6",
  api: "anthropic-messages",
  provider: "anthropic",
};

const options = { apiKey: "fixture-token", reasoningEffort: "medium" as const };
const completionsTransport = createOpenAICompletionsTransportStreamFn();
const anthropicTransport = createAnthropicMessagesTransportStreamFn();
const implementations = [
  ["Completions SDK", model.api, streamOpenAICompletions.bind(null, model, context)],
  ["Completions transport", model.api, completionsTransport.bind(null, model, context)],
  ["Anthropic SDK", anthropic.api, streamAnthropic.bind(null, anthropic, context)],
  ["Anthropic transport", anthropic.api, anthropicTransport.bind(null, anthropic, context)],
] as const;
function frame(type: string, fields: Record<string, unknown>) {
  return { type, ...fields };
}
const socketError = (code = "ECONNRESET") => Object.assign(new Error("socket closed"), { code });

describe.each(implementations)("%s transport failures", (_name, api, stream) => {
  const createStream = (signal?: AbortSignal) => stream({ ...options, signal });
  it.each(["ECONNRESET", "UND_ERR_SOCKET", "AggregateError", "provider rejection", "caller abort"])(
    "classifies pre-response %s without replaying the fetch",
    async (failure) => {
      const controller = new AbortController();
      const transportFailure = !["caller abort", "provider rejection"].includes(failure);
      const fetchFailure = vi.fn<typeof fetch>(async () => {
        if (failure === "provider rejection") {
          return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
            status: 401,
          });
        }
        if (failure === "caller abort") {
          controller.abort();
        }
        const error = socketError(failure === "UND_ERR_SOCKET" ? failure : "ECONNRESET");
        if (failure === "AggregateError") {
          throw new AggregateError([error], "Multiple connections failed");
        }
        throw failure === "UND_ERR_SOCKET"
          ? new TypeError("fetch failed", { cause: error })
          : error;
      });
      configureAiTransportHost({ buildModelFetch: () => fetchFailure });
      const result = await (await createStream(controller.signal)).result();
      expect(fetchFailure).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe(failure === "caller abort" ? "aborted" : "error");
      if (transportFailure) {
        expect(result.content).toEqual([]);
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            type: "provider_transport_failure",
            timestamp: expect.any(Number),
            error: expect.objectContaining({ message: expect.any(String) }),
            details: { eventsEmitted: false, phase: "before_message_stream_start" },
          }),
        );
      } else {
        expect(result.diagnostics).toBeUndefined();
      }
    },
  );

  it.each(["text", "thinking", "toolCall"] as const)(
    "does not mark a socket drop after a %s delta",
    async (kind) => {
      const isTool = kind === "toolCall";
      const openAiDelta = isTool
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"value":' },
              },
            ],
          }
        : { [kind === "text" ? "content" : "reasoning_content"]: "Partial" };
      const anthropicBlock = isTool
        ? { type: "tool_use", id: "call_1", name: "lookup", input: {} }
        : { type: kind, [kind]: "Partial" };
      const anthropicDelta = isTool
        ? { type: "input_json_delta", partial_json: '{"value":' }
        : { type: `${kind}_delta`, [kind]: " more" };
      const events =
        api === "anthropic-messages"
          ? [
              frame("message_start", {
                message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
              }),
              frame("content_block_start", { index: 0, content_block: anthropicBlock }),
              frame("content_block_delta", { index: 0, delta: anthropicDelta }),
            ]
          : [{ choices: [{ index: 0, delta: openAiDelta, finish_reason: null }] }];
      const body = events
        .map(
          (event) =>
            `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
      let failBody: (() => void) | undefined;
      const fetchStream: typeof fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              failBody = () => controller.error(socketError());
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      configureAiTransportHost({ buildModelFetch: () => fetchStream });

      const response = await createStream();
      let sawDelta = false;
      for await (const event of response) {
        if (event.type.endsWith("_delta")) {
          sawDelta = true;
          failBody?.();
        }
      }
      const result = await response.result();
      expect(sawDelta).toBe(true);

      expect(result.stopReason).toBe("error");
      expect(
        result.diagnostics?.some((diagnostic) => diagnostic.type === "provider_transport_failure"),
      ).not.toBe(true);
    },
  );
});
