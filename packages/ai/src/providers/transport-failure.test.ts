import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createAnthropicMessagesTransportStreamFn } from "../transports/anthropic-transport-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { Context } from "../types.js";
import { streamAnthropic } from "./anthropic.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { makeProviderModel } from "./provider-model.test-support.js";
import { frame, serializeSse } from "./provider-stream.test-support.js";

const initialHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(initialHost));

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
const model = makeProviderModel("openai-completions", "openai", "gpt-5.6-luna", {
  baseUrl: "https://provider.test/v1",
});
const anthropic = makeProviderModel("anthropic-messages", "anthropic", "sonnet-4.6", {
  baseUrl: model.baseUrl,
});

const options = { apiKey: "fixture-token", reasoningEffort: "medium" as const };
const completionsTransport = createOpenAICompletionsTransportStreamFn();
const anthropicTransport = createAnthropicMessagesTransportStreamFn();
const implementations = [
  ["Completions SDK", model.api, streamOpenAICompletions.bind(null, model, context)],
  ["Completions transport", model.api, completionsTransport.bind(null, model, context)],
  ["Anthropic SDK", anthropic.api, streamAnthropic.bind(null, anthropic, context)],
  ["Anthropic transport", anthropic.api, anthropicTransport.bind(null, anthropic, context)],
] as const;
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
            details: { eventsEmitted: false, phase: "before_message_stream_start" },
          }),
        );
      } else {
        expect(result.diagnostics).toBeUndefined();
      }
    },
  );

  it("does not mark a socket drop after content starts", async () => {
    const events =
      api === "anthropic-messages"
        ? [
            frame("message_start", {
              message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
            }),
            frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
            frame("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: "Partial" },
            }),
          ]
        : [{ choices: [{ index: 0, delta: { content: "Partial" }, finish_reason: null }] }];
    let failBody: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(serializeSse(events)));
        failBody = () => controller.error(socketError());
      },
    });
    configureAiTransportHost({
      buildModelFetch: () => async () =>
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });

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
  });
});
