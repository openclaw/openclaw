import type { ClientOptions } from "openai";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";

const openAiMockState = vi.hoisted(() => ({
  configs: [] as ClientOptions[],
  params: [] as unknown[],
  requestOptions: [] as unknown[],
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: vi.fn((params: unknown, requestOptions: unknown) => {
        openAiMockState.params.push(params);
        openAiMockState.requestOptions.push(requestOptions);
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: ClientOptions) {
      openAiMockState.configs.push(config);
    }
  },
}));

import { createOpenAIResponsesClient } from "../transports/openai-responses-client.js";
import { buildOpenAIResponsesParams } from "../transports/openai-responses-params-internal.js";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "./openai-responses.js";

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

function model(overrides: Partial<Model<"openai-responses">> = {}) {
  return {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } satisfies Model<"openai-responses">;
}

describe("OpenAI Responses provider", () => {
  afterEach(() => {
    openAiMockState.configs = [];
    openAiMockState.params = [];
    openAiMockState.requestOptions = [];
    configureAiTransportHost({});
  });

  it.each([
    {
      label: "raw schema",
      responseFormat: { type: "object", properties: { answer: { type: "string" } } },
      expected: {
        type: "json_schema",
        name: "openclaw_response",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
    },
    {
      label: "nested schema",
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "answer", schema: { type: "object" }, strict: false },
      },
      expected: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
        strict: false,
      },
    },
    {
      label: "native schema",
      responseFormat: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
        strict: null,
      },
      expected: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
        strict: null,
      },
    },
    {
      label: "text",
      responseFormat: { type: "text" },
      expected: { type: "text" },
    },
  ])(
    "projects $label output constraints in provider and transport requests",
    async ({ responseFormat, expected }) => {
      const options = { apiKey: "test", responseFormat };
      const transportParams = buildOpenAIResponsesParams(model(), context, options);
      await streamSimpleOpenAIResponses(model(), context, options).result();
      expect(transportParams.text?.format).toEqual(expected);
      expect(openAiMockState.params[0]).toMatchObject({ text: { format: expected } });
    },
  );

  it("identifies OpenCode conversations with long cache retention", async () => {
    await streamOpenAIResponses(model({ baseUrl: "https://opencode.ai/zen/v1" }), context, {
      apiKey: "test",
      sessionId: "conversation-123",
      cacheRetention: "long",
    }).result();
    expect(openAiMockState.configs[0]).toMatchObject({
      defaultHeaders: { "x-opencode-session": "conversation-123" },
    });
  });

  it("sends priority service tier from simple completions", async () => {
    await streamSimpleOpenAIResponses(model(), context, {
      apiKey: "test",
      serviceTier: "priority",
    }).result();
    expect(openAiMockState.params).toHaveLength(1);
    expect(openAiMockState.params[0]).toMatchObject({ service_tier: "priority" });
  });

  it("routes the SDK fetch through the host guard without changing the request or response", async () => {
    const hostResponse = new Response("synthetic rejection", { status: 500 });
    const hostFetch = vi.fn<typeof fetch>(async () => hostResponse);
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    const result = await streamOpenAIResponses(model(), context, {
      apiKey: "sentinel-key",
    }).result();

    expect(result.stopReason).toBe("error");
    // Fail before a terminal usage event: zeros are unmeasured, not free.
    expect(result.usage).toMatchObject({
      input: 0,
      output: 0,
      totalTokens: 0,
      usageReport: { state: "unavailable" },
    });
    expect(openAiMockState.configs).toHaveLength(1);
    expect(openAiMockState.configs[0]).toMatchObject({ maxRetries: 0 });
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ input: "synthetic request" }),
    });
    const init = {
      headers: { authorization: "Bearer sentinel-key" },
      signal: new AbortController().signal,
    };
    expect(await openAiMockState.configs[0]?.fetch?.(request, init)).toBe(hostResponse);
    expect(hostFetch).toHaveBeenCalledExactlyOnceWith(request, init);
    expect(hostResponse.bodyUsed).toBe(false);
  });

  it("fails closed before constructing an OpenAI client for another provider without an endpoint", async () => {
    const missingEndpointModel = {
      ...model(),
      provider: "openrouter",
      baseUrl: undefined,
    } as unknown as Model<"openai-responses">;

    const result = await streamOpenAIResponses(missingEndpointModel, context, {
      apiKey: "sentinel-openrouter-key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('Provider "openrouter" requires an explicit base URL');
    expect(() =>
      createOpenAIResponsesClient(missingEndpointModel, "sentinel-openrouter-key", {}),
    ).toThrow('Provider "openrouter" requires an explicit base URL');
    expect(openAiMockState.configs).toEqual([]);

    const configuredModel = {
      ...missingEndpointModel,
      baseUrl: "https://openrouter.ai/api/v1",
    };
    await streamOpenAIResponses(configuredModel, context, {
      apiKey: "sentinel-openrouter-key",
    }).result();
    expect(() =>
      createOpenAIResponsesClient(configuredModel, "sentinel-openrouter-key", {}),
    ).not.toThrow();
    expect(
      openAiMockState.configs.map((config) => (config as { baseURL?: string }).baseURL),
    ).toEqual(["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1"]);
  });

  it("keeps Cloudflare composed upstream auth opaque in SDK headers", async () => {
    const hostResponse = new Response(null, { status: 500 });
    const hostFetch = vi.fn<typeof fetch>(async () => hostResponse);
    const apiKey = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    await streamOpenAIResponses(
      model({
        provider: "cloudflare-ai-gateway",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
      }),
      context,
      { apiKey },
    ).result();

    const config = openAiMockState.configs[0];
    assert.isDefined(config);
    expect(config).toMatchObject({
      apiKey,
      baseURL: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
      defaultHeaders: {
        Authorization: null,
        "cf-aig-authorization": `Bearer ${apiKey}`,
      },
    });
    const request = new Request(`${config.baseURL}/responses`, {
      headers: {
        "cf-aig-authorization": `Bearer ${apiKey}`,
      },
    });
    expect(await config.fetch?.(request)).toBe(hostResponse);
    expect(hostFetch).toHaveBeenCalledExactlyOnceWith(request, undefined);
  });

  it("clamps small output limits and disables implicit SDK retries", async () => {
    const requestModel = model();
    const options = {
      apiKey: String(1),
      maxTokens: 1,
    };
    const transportParams = buildOpenAIResponsesParams(requestModel, context, options);
    const result = await streamOpenAIResponses(requestModel, context, options).result();

    expect(result.stopReason).toBe("error");
    for (const params of [transportParams, openAiMockState.params[0]]) {
      expect(params).toMatchObject({ store: false, max_output_tokens: 16 });
    }
    expect(openAiMockState.requestOptions[0]).toMatchObject({ maxRetries: 0 });
  });

  it.each([
    { id: "gpt-5.6-sol", cacheRetention: "long", ttl: "30m", retention: undefined },
    { id: "gpt-5.6-sol", cacheRetention: "none", ttl: undefined, retention: undefined },
    { id: "gpt-5.5", cacheRetention: "long", ttl: undefined, retention: "24h" },
  ] as const)(
    "serializes $id $cacheRetention caching through both Responses builders",
    async ({ id, cacheRetention, ttl, retention }) => {
      const requestModel = model({ id });
      const options = { apiKey: "sentinel-key", sessionId: "cache-session", cacheRetention };
      const transportParams = buildOpenAIResponsesParams(requestModel, context, options);
      await streamOpenAIResponses(requestModel, context, options).result();

      for (const params of [transportParams, openAiMockState.params[0]]) {
        expect(params).toHaveProperty(
          "prompt_cache_key",
          cacheRetention === "none" ? undefined : "cache-session",
        );
        expect(params).toMatchObject({ model: id });
        expect((params as { prompt_cache_retention?: unknown }).prompt_cache_retention).toBe(
          retention,
        );
        if (ttl) {
          expect(params).toHaveProperty("prompt_cache_options", { ttl });
        } else {
          expect(params).not.toHaveProperty("prompt_cache_options");
        }
      }
    },
  );

  it("omits cache fields for custom endpoints without cache-key opt-in", async () => {
    const requestModel = model({ id: "gpt-5.6-sol", baseUrl: "https://proxy.example/v1" });
    const options = { apiKey: "sentinel-key", cacheRetention: "long" as const };
    const transportParams = buildOpenAIResponsesParams(requestModel, context, options);
    await streamOpenAIResponses(requestModel, context, options).result();

    expect(transportParams.prompt_cache_retention).toBeUndefined();
    expect(openAiMockState.params[0]).not.toHaveProperty("prompt_cache_retention");
    for (const params of [transportParams, openAiMockState.params[0]]) {
      expect(params).not.toHaveProperty("prompt_cache_options");
    }
  });

  it.each([
    { id: "gpt-6.1-sol", reasoningEffort: undefined, expectedEffort: undefined },
    { id: "gpt-6.1-sol", reasoningEffort: "minimal", expectedEffort: "low" },
    { id: "gpt-6-luna", reasoningEffort: "max", expectedEffort: "max" },
  ] as const)(
    "honors $id reasoning and sampling without catalog metadata for $reasoningEffort",
    async ({ id, reasoningEffort, expectedEffort }) => {
      const requestModel = model({ id });
      const options = { apiKey: "sentinel-key", reasoningEffort, temperature: 0.5, topP: 0.8 };
      const transportParams = buildOpenAIResponsesParams(requestModel, context, options);
      await streamOpenAIResponses(requestModel, context, options).result();

      for (const params of [transportParams, openAiMockState.params[0]]) {
        const request = params as {
          reasoning?: { effort: string };
          temperature?: number;
          top_p?: number;
        };
        expect(request.reasoning?.effort).toBe(expectedEffort);
        expect(request.temperature).toBeUndefined();
        expect(request.top_p).toBeUndefined();
      }
    },
  );
});
