// The managed Responses transport must price usage through the canonical
// model-aware service-tier helper. A transport-local flat table previously
// drifted (2x while gpt-5.5 priority bills 2.5x) and understated UI cost.
import type { Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleOpenAIResponses } from "../providers/openai-responses.js";
import {
  responsesServiceTierObserver,
  type ResponsesServiceTierObservation,
} from "./openai-responses-contracts.js";
import type { SdkResponse } from "./openai-responses-sdk.test-support.js";

const sseState = vi.hoisted(() => ({
  outcomes: [] as Array<Error | SdkResponse>,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", async () => {
  const { createResponsesSdkMock } = await import("./openai-responses-sdk.test-support.js");
  return createResponsesSdkMock(sseState);
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: function UnexpectedResponsesWS() {
    throw new Error("pricing tests must not construct a WebSocket");
  },
}));

import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Cost figures are per million tokens; usage below uses 1M input + 1M output
// so the expected totals read directly off the multiplied unit prices.
const model = {
  id: "gpt-5.5",
  name: "GPT 5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function completedResponse(
  serviceTier: string | null | undefined,
  cachedTokens = 0,
  cacheWriteTokens = 0,
  cacheWriteDetails?: { ttl_30m_tokens: number; ttl_12h_tokens: number },
): SdkResponse {
  return {
    data: (async function* () {
      yield {
        type: "response.completed",
        response: {
          id: "resp_priced",
          model: "gpt-5.5",
          status: "completed",
          service_tier: serviceTier,
          output: [
            {
              id: "msg_priced",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 1_000_000,
            input_tokens_details: {
              cached_tokens: cachedTokens,
              cache_write_tokens: cacheWriteTokens,
              cache_write_tokens_details: cacheWriteDetails,
            },
            output_tokens: 1_000_000,
            total_tokens: 2_000_000,
          },
        },
      };
    })(),
    response: new Response(null, { status: 200 }),
  };
}

describe("managed Responses transport service-tier pricing", () => {
  afterEach(() => {
    sseState.outcomes.length = 0;
    sseState.requests.length = 0;
  });

  it("applies the canonical 2.5x gpt-5.5 priority multiplier to usage cost", async () => {
    sseState.outcomes.push(completedResponse("priority"));
    const stream = await createOpenAIResponsesTransportStreamFn()(
      model,
      { messages: [], tools: [] },
      { apiKey: "test-key", sessionId: "session-pricing", transport: "sse" } as never,
    );
    const result = await stream.result();
    // Base cost 2 + 10 = 12; gpt-5.5 priority is 2.5x = 30 (flat 2x would be 24).
    expect(result.usage.cost.total).toBeCloseTo(30, 6);
  });

  it.each([
    { route: "managed", ttl: "30m", expectedWrite: 2.5 },
    { route: "managed", ttl: "12h", expectedWrite: 5 },
    { route: "simple", ttl: "30m", expectedWrite: 2.5 },
    { route: "simple", ttl: "12h", expectedWrite: 5 },
  ] as const)(
    "prices $route $ttl cache writes without charging ordinary input twice",
    async ({ route, ttl, expectedWrite }) => {
      sseState.outcomes.push(completedResponse("default", 0, 1_000_000));
      const pricedModel = { ...model, id: "gpt-6.1-sol", cost: { ...model.cost, cacheWrite: 2.5 } };
      const streamFn =
        route === "managed"
          ? createOpenAIResponsesTransportStreamFn()
          : streamSimpleOpenAIResponses;
      const stream = await streamFn(
        pricedModel,
        { messages: [] },
        { apiKey: "test-key", promptCacheTtl: ttl },
      );
      const result = await stream.result();
      expect(result.stopReason).toBe("stop");
      expect(sseState.requests[0]).toHaveProperty("prompt_cache_options.ttl", ttl);
      expect(result.usage.cost.input).toBe(0);
      expect(result.usage.cost.cacheWrite).toBeCloseTo(expectedWrite, 6);
      expect(result.usage.cost.total).toBeCloseTo(10 + expectedWrite, 6);
    },
  );

  it.each([
    { route: "managed", ttl: "12h", extended: 4000, expectedWrite: 0.0275, expectedInput: 1.978 },
    { route: "simple", ttl: "12h", extended: 4000, expectedWrite: 0.0275, expectedInput: 1.978 },
    { route: "managed", ttl: "30m", extended: 4000, expectedWrite: 0.0275, expectedInput: 1.978 },
    { route: "simple", ttl: "30m", extended: 4000, expectedWrite: 0.0275, expectedInput: 1.978 },
    { route: "managed", ttl: "12h", extended: 0, expectedWrite: 0.0075, expectedInput: 1.986 },
    { route: "simple", ttl: "12h", extended: 0, expectedWrite: 0.0075, expectedInput: 1.986 },
  ] as const)(
    "prices reported lifetime buckets on $route despite the $ttl request default: $extended extended tokens",
    async ({ route, ttl, extended, expectedWrite, expectedInput }) => {
      sseState.outcomes.push(
        completedResponse("default", 4000, 3000 + extended, {
          ttl_30m_tokens: 3000,
          ttl_12h_tokens: extended,
        }),
      );
      const pricedModel = {
        ...model,
        id: "gpt-6.1-sol",
        cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      };
      const streamFn =
        route === "managed"
          ? createOpenAIResponsesTransportStreamFn()
          : streamSimpleOpenAIResponses;
      const stream = await streamFn(
        pricedModel,
        { messages: [] },
        { apiKey: "test-key", promptCacheTtl: ttl },
      );
      const result = await stream.result();
      expect(result.stopReason).toBe("stop");
      expect(result.usage.cacheWrite).toBe(3000 + extended);
      expect(result.usage.cost.cacheWrite).toBeCloseTo(expectedWrite, 10);
      expect(result.usage.cost.input).toBeCloseTo(expectedInput, 10);
      expect(result.usage.cost.cacheRead).toBeCloseTo(0.0004, 10);
      expect(result.usage.cost.total).toBeCloseTo(expectedInput + 10 + 0.0004 + expectedWrite, 10);
    },
  );

  it.each([
    { route: "managed", responseTier: "ultrafast" },
    { route: "simple", responseTier: "default" },
    { route: "simple", responseTier: undefined },
  ])(
    "observes $route terminal tier $responseTier against the final payload",
    async ({ route, responseTier }) => {
      sseState.outcomes.push(completedResponse(responseTier, 640_000));
      const observations: ResponsesServiceTierObservation[] = [];
      const options = {
        apiKey: "test-key",
        transport: "sse" as const,
        serviceTier: "priority" as const,
        onPayload: (payload: unknown) => ({
          ...(payload as Record<string, unknown>),
          service_tier: "ultrafast",
        }),
      };
      responsesServiceTierObserver.set(options, (observation) => observations.push(observation));
      const streamFn =
        route === "managed"
          ? createOpenAIResponsesTransportStreamFn()
          : streamSimpleOpenAIResponses;
      const stream = await streamFn(model, { messages: [], tools: [] }, { ...options });
      expect((await stream.result()).stopReason).toBe("stop");
      expect(sseState.requests[0]?.service_tier).toBe("ultrafast");
      expect(observations).toEqual(
        responseTier === "ultrafast" || responseTier === "default"
          ? [
              {
                requestedTier: "ultrafast",
                responseTier,
                responseId: "resp_priced",
                responseModel: "gpt-5.5",
                inputTokens: 1_000_000,
                cachedTokens: 640_000,
              },
            ]
          : [],
      );
    },
  );
});
