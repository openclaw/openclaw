import { expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import {
  anthropicEvents,
  anthropicModel,
  context,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { streamAnthropic, streamSimpleAnthropic } from "./providers/anthropic.js";
import { createAnthropicMessagesTransportStreamFn } from "./transports/anthropic-transport-stream.js";

registerParityHostLifecycle();
const routes = ["provider", "simple", "transport"] as const;
function streamFor(route: (typeof routes)[number], maxTokens?: number, ceiling?: number) {
  const model = {
    ...anthropicModel,
    id: "custom-model",
    reasoning: false,
    contextWindow: undefined,
    maxTokens: ceiling,
  };
  const options = { apiKey: "synthetic-test-key", maxTokens, reasoning: "off" as const };
  return route === "provider"
    ? streamAnthropic(model, context, options)
    : route === "simple"
      ? streamSimpleAnthropic(model, context, options)
      : createAnthropicMessagesTransportStreamFn()(model, context, options);
}
it.each(routes)("rejects missing and invalid output bounds before %s POST", async (route) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  configureAiTransportHost({ ...getAiTransportHost(), buildModelFetch: () => fetch });
  for (const requested of [undefined, 0, -1, 1.5, Number.NaN, Infinity]) {
    let result;
    try {
      const stream = await streamFor(route, requested);
      result = await stream.result();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
    }
    if (result) {
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("maxTokens");
    }
    expect(fetch).not.toHaveBeenCalled();
  }
});
it.each(routes)("uses explicit or qualified bounds on the actual %s request", async (route) => {
  const payloads: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    payloads.push(JSON.parse(await new Request(input, init).text()));
    return createAnthropicResponse(anthropicEvents);
  });
  configureAiTransportHost({ ...getAiTransportHost(), buildModelFetch: () => fetch });
  for (const [requested, ceiling, expected] of [
    [256, undefined, 256],
    [256, 128, 128],
    [undefined, 512, 512],
  ]) {
    const stream = await streamFor(route, requested, ceiling);
    expect((await stream.result()).stopReason).toBe("stop");
    expect(payloads.at(-1)).toMatchObject({ max_tokens: expected, model: "custom-model" });
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});
