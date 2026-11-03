import type { ClientOptions } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";

const openAiMockState = vi.hoisted(() => ({
  configs: [] as ClientOptions[],
  params: [] as ResponseCreateParamsStreaming[],
  requestOptions: [] as unknown[],
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: vi.fn((params: ResponseCreateParamsStreaming, requestOptions: unknown) => {
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
import type { OpenAIResponsesOptions as Options } from "../transports/openai-responses-contracts.js";
import { buildOpenAIResponsesParams } from "../transports/openai-responses-params-internal.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "./openai-responses.js";

const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } satisfies Context;
type ResponsesModel = Model<"openai-responses">;

function model(overrides: Partial<ResponsesModel> = {}) {
  return makeOpenAIProviderModel("openai-responses", {
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  });
}

function runRequest(options: Options, requestModel = model()) {
  return streamOpenAIResponses(requestModel, context, options).result();
}

async function bothRequests(options: Options, overrides: Partial<ResponsesModel> = {}) {
  const requestModel = model(overrides);
  const requestOptions = { apiKey: "sentinel-key", ...options };
  const params = buildOpenAIResponsesParams(requestModel, context, requestOptions);
  const result = await runRequest(requestOptions, requestModel);
  expect(result.stopReason).toBe("error");
  const capturedParams = openAiMockState.params[0];
  assert.isDefined(capturedParams);
  return [params, capturedParams] as const;
}

function guardedResponse(body: string | null = null) {
  const hostResponse = new Response(body, { status: 500 });
  const hostFetch = vi.fn<typeof fetch>(async () => hostResponse);
  configureAiTransportHost({ buildModelFetch: () => hostFetch });
  return { hostResponse, hostFetch };
}

const schema = { type: "object", properties: { answer: { type: "string" } } };
const rawFormat = { type: "json_schema", name: "openclaw_response", schema };
const nestedSchema = { name: "answer", schema: { type: "object" }, strict: false };
const nestedInput = { type: "json_schema", json_schema: nestedSchema };
const nestedFormat = { type: "json_schema", ...nestedSchema };
const nativeFormat = { ...nestedFormat, strict: null };

describe("OpenAI Responses provider", () => {
  afterEach(() => {
    openAiMockState.configs = [];
    openAiMockState.params = [];
    openAiMockState.requestOptions = [];
    configureAiTransportHost({});
  });

  it.each([
    ["raw schema", structuredClone(schema), rawFormat],
    ["nested schema", structuredClone(nestedInput), nestedFormat],
    ["native schema", structuredClone(nativeFormat), nativeFormat],
    ["text", { type: "text" }, { type: "text" }],
  ] as const)(
    "projects %s output constraints in provider and transport requests",
    async (_label, responseFormat, expected) => {
      const options = { apiKey: "test", responseFormat };
      const transportParams = buildOpenAIResponsesParams(model(), context, options);
      await streamSimpleOpenAIResponses(model(), context, options).result();
      expect(transportParams.text?.format).toEqual(expected);
      expect(openAiMockState.params[0]).toMatchObject({ text: { format: expected } });
    },
  );

  it("identifies OpenCode conversations with long cache retention", async () => {
    await runRequest(
      { apiKey: "test", sessionId: "conversation-123", cacheRetention: "long" },
      model({ baseUrl: "https://opencode.ai/zen/v1" }),
    );
    expect(openAiMockState.configs[0]).toMatchObject({
      defaultHeaders: { "x-opencode-session": "conversation-123" },
    });
  });

  it("sends priority service tier from simple completions", async () => {
    const options = { apiKey: "test", serviceTier: "priority" } as const;
    await streamSimpleOpenAIResponses(model(), context, options).result();
    expect(openAiMockState.params).toHaveLength(1);
    expect(openAiMockState.params[0]).toMatchObject({ service_tier: "priority" });
  });

  it("routes the SDK fetch through the host guard without changing the request or response", async () => {
    const { hostResponse, hostFetch } = guardedResponse("synthetic rejection");
    const result = await runRequest({ apiKey: "sentinel-key" });
    // Fail before a terminal usage event: zeros are unmeasured, not free.
    expect(result).toMatchObject({
      stopReason: "error",
      usage: { input: 0, output: 0, totalTokens: 0, usageReport: { state: "unavailable" } },
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
    } as unknown as ResponsesModel;
    const apiKey = "sentinel-openrouter-key";
    const result = await runRequest({ apiKey }, missingEndpointModel);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('Provider "openrouter" requires an explicit base URL');
    expect(() => createOpenAIResponsesClient(missingEndpointModel, apiKey, {})).toThrow(
      'Provider "openrouter" requires an explicit base URL',
    );
    expect(openAiMockState.configs).toEqual([]);

    const baseUrl = "https://openrouter.ai/api/v1";
    const configuredModel = { ...missingEndpointModel, baseUrl };
    await runRequest({ apiKey }, configuredModel);
    expect(() => createOpenAIResponsesClient(configuredModel, apiKey, {})).not.toThrow();
    expect(openAiMockState.configs.map((config) => config.baseURL)).toEqual([baseUrl, baseUrl]);
  });

  it("keeps Cloudflare composed upstream auth opaque in SDK headers", async () => {
    const { hostResponse, hostFetch } = guardedResponse();
    const apiKey = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    const baseUrl = "https://gateway.ai.cloudflare.com/v1/account/gateway/openai";
    await runRequest({ apiKey }, model({ provider: "cloudflare-ai-gateway", baseUrl }));
    const config = openAiMockState.configs[0];
    assert.isDefined(config);
    expect(config).toMatchObject({
      apiKey,
      baseURL: baseUrl,
      defaultHeaders: { Authorization: null, "cf-aig-authorization": `Bearer ${apiKey}` },
    });
    const outgoing = new Request(`${config.baseURL}/responses`, {
      headers: { "cf-aig-authorization": `Bearer ${apiKey}` },
    });
    expect(await config.fetch?.(outgoing)).toBe(hostResponse);
    expect(hostFetch).toHaveBeenCalledExactlyOnceWith(outgoing, undefined);
  });

  it("clamps small output limits and disables implicit SDK retries", async () => {
    const requests = await bothRequests({ apiKey: String(1), maxTokens: 1 });
    for (const params of requests) {
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
      const requests = await bothRequests({ sessionId: "cache-session", cacheRetention }, { id });
      for (const params of requests) {
        expect(params).toHaveProperty(
          "prompt_cache_key",
          cacheRetention === "none" ? undefined : "cache-session",
        );
        expect(params).toMatchObject({ model: id });
        expect(params.prompt_cache_retention).toBe(retention);
        if (ttl) {
          expect(params).toHaveProperty("prompt_cache_options", { ttl });
        } else {
          expect(params).not.toHaveProperty("prompt_cache_options");
        }
      }
    },
  );

  it.each<[Options, Partial<ResponsesModel>, "30m" | "12h" | undefined]>([
    [{ cacheRetention: "long" }, { id: "gpt-5.6-sol" }, "12h"],
    [{ promptCacheTtl: "30m" }, {}, "30m"],
    [{ cacheRetention: "none" }, {}, undefined],
    [{}, { id: "gpt-5.5" }, undefined],
    [{}, { compat: { supportsLongCacheRetention: false } }, undefined],
    [{}, { baseUrl: "https://proxy.example/v1" }, undefined],
  ])(
    "honors the explicit Responses cache lifetime only on eligible routes: %j",
    async (options, modelOverrides, ttl) => {
      const requests = await bothRequests(
        { sessionId: "cache-session", promptCacheTtl: "12h", ...options },
        { id: "gpt-6.1-sol", ...modelOverrides },
      );
      for (const params of requests) {
        expect(params.prompt_cache_options).toEqual(ttl ? { ttl } : undefined);
        expect(params.prompt_cache_retention).toBeUndefined();
      }
    },
  );

  it("preserves the cache lifetime through simple Responses completions", async () => {
    await streamSimpleOpenAIResponses(model({ id: "gpt-6.1-sol" }), context, {
      apiKey: "test",
      promptCacheTtl: "12h",
    }).result();
    expect(openAiMockState.params[0]).toMatchObject({ prompt_cache_options: { ttl: "12h" } });
  });

  it("omits cache fields for custom endpoints without cache-key opt-in", async () => {
    const requests = await bothRequests(
      { cacheRetention: "long" },
      { id: "gpt-5.6-sol", baseUrl: "https://proxy.example/v1" },
    );
    expect(requests[0].prompt_cache_retention).toBeUndefined();
    expect(requests[1]).not.toHaveProperty("prompt_cache_retention");
    for (const params of requests) {
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
      const requests = await bothRequests({ reasoningEffort, temperature: 0.5, topP: 0.8 }, { id });
      for (const params of requests) {
        expect(params.reasoning?.effort).toBe(expectedEffort);
        expect(params.temperature).toBeUndefined();
        expect(params.top_p).toBeUndefined();
      }
    },
  );
});
