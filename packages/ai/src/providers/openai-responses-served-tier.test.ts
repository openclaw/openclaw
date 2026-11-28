import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAIResponsesTransportStreamFn } from "../transports/openai-responses-client.js";
import type { Context } from "../types.js";
import { streamOpenAIResponses } from "./openai-responses.js";
import { makeProviderModel } from "./provider-model.test-support.js";

let previousHost: ReturnType<typeof getAiTransportHost>;
beforeEach(() => {
  previousHost = getAiTransportHost();
});
afterEach(() => {
  configureAiTransportHost(previousHost);
  vi.restoreAllMocks();
});

describe.each(["SDK", "managed"])("%s Responses served-tier pricing", (transport) => {
  it.each([
    { tier: "fast", expected: 0.0042 },
    { tier: "default", expected: 0.0021 },
  ])("prices served $tier instead of requested priority", async ({ tier, expected }) => {
    const model = makeProviderModel("openai-responses", "openai", "gpt-6.2-sol", {
      baseUrl: "https://api.openai.com/v1",
      cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    });
    let requestBody: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requestBody = await new Request(input, init).json();
      const event = {
        type: "response.completed",
        response: {
          id: "resp_served_tier",
          model: model.id,
          status: "completed",
          service_tier: tier,
          output: [],
          usage: { input_tokens: 1_000, output_tokens: 10, total_tokens: 1_010 },
        },
      };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    configureAiTransportHost({ buildModelFetch: () => fetch });
    const context: Context = {
      messages: [{ role: "user", content: "Synthetic pricing check", timestamp: 0 }],
    };
    const options = { apiKey: "synthetic-key", serviceTier: "priority" as const };
    const stream = await (transport === "SDK"
      ? streamOpenAIResponses(model, context, options)
      : createOpenAIResponsesTransportStreamFn()(model, context, options));
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestBody).toMatchObject({ service_tier: "priority" });
    expect(result.usage.cost.total).toBeCloseTo(expected, 10);
  });
});
