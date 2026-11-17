import {
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import { calculateCost, type Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";
import { resolveModelRoutes } from "./provider-policy-api.js";
import { wrapOpenAIResponsesStream } from "./responses-stream.runtime.js";

const ids = ["gpt-6.2-astra", "gpt-6.2-sol"] as const;
const registry = {
  find: () => undefined,
  getAll: () => [],
  getAvailable: () => [],
  hasConfiguredAuth: () => false,
};

afterEach(() => vi.restoreAllMocks());

it.each([
  { id: "gpt-6.2-astra", prompt: 272_000, total: 2.2104 },
  { id: "gpt-6.2-astra", prompt: 272_001, total: 4.400816 },
  { id: "gpt-6.2-sol", prompt: 272_000, total: 0.5526 },
  { id: "gpt-6.2-sol", prompt: 272_001, total: 1.100204 },
])("prices $id at $prompt prompt tokens as one request tier", ({ id, prompt, total }) => {
  const model = buildOpenAIProvider().resolveDynamicModel?.({
    provider: "openai",
    modelId: id,
    modelRegistry: registry,
  });
  if (!model) throw new Error("missing model");
  const cost = calculateCost(model, {
    input: prompt - 2_000,
    output: 1_000,
    cacheRead: 1_000,
    cacheWrite: 1_000,
    totalTokens: prompt + 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  expect(cost.total).toBeCloseTo(total, 10);
});

it.each(
  ids.flatMap((id) => [
    { id, fastMode: false, tier: "default", total: id === "gpt-6.2-astra" ? 0.0084 : 0.0021 },
    { id, fastMode: true, tier: "priority", total: id === "gpt-6.2-astra" ? 0.0168 : 0.0042 },
    {
      id,
      fastMode: "ultrafast" as const,
      tier: "ultrafast",
      total: id === "gpt-6.2-astra" ? 0.0252 : 0.0063,
    },
  ]),
)("sends and prices $id on $tier", async ({ id, fastMode, tier, total }) => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-17T12:00:00Z"));
  const model = buildOpenAIProvider().resolveDynamicModel?.({
    provider: "openai",
    modelId: id,
    modelRegistry: registry,
  });
  if (!model) throw new Error("missing model");
  const bodies: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    bodies.push((await new Request(input, init).json()) as Record<string, unknown>);
    const event = {
      type: "response.completed",
      response: {
        id: "resp_synthetic_pricing",
        model: id,
        status: "completed",
        service_tier: tier,
        output: [],
        usage: { input_tokens: 1_000, output_tokens: 10, total_tokens: 1_010 },
      },
    };
    return new Response("data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const stream = wrapOpenAIResponsesStream({
    provider: "openai",
    modelId: id,
    model,
    nativeWebSearchAllowedByToolPolicy: false,
    extraParams: { fastMode },
    streamFn: createOpenAIResponsesTransportStreamFn(),
  });
  const result = await (
    await stream(
      model,
      {
        messages: [{ role: "user", content: "Synthetic pricing proof", timestamp: 0 }],
      },
      { apiKey: "synthetic-key" },
    )
  ).result();
  expect(result.stopReason).toBe("stop");
  expect(bodies).toHaveLength(1);
  if (tier === "default") {
    expect(bodies[0]).not.toHaveProperty("service_tier");
  } else {
    expect(bodies[0]).toHaveProperty("service_tier", tier);
  }
  expect(result.usage.cost.total).toBeCloseTo(total, 10);
});

it.each(ids)("offers both API-key and subscription billing routes for %s", (id) => {
  expect(resolveModelRoutes({ provider: "openai", modelId: id, env: {} })).toMatchObject({
    kind: "routes",
    routes: [
      { api: "openai-responses", authRequirement: "api-key" },
      { api: "openai-chatgpt-responses", authRequirement: "subscription" },
    ],
  });
});

it.each(
  ids.flatMap((id) =>
    (["openai-responses", "openai-chatgpt-responses"] as const).map((api) => ({ id, api })),
  ),
)(
  "resolves $id for $api with its image, reasoning, context and billing contract",
  ({ id, api }) => {
    const model = buildOpenAIProvider().resolveDynamicModel?.({
      provider: "openai",
      modelId: id,
      modelRegistry: registry,
      providerConfig: {
        api,
        models: [],
        baseUrl:
          api === "openai-responses"
            ? "https://api.openai.com/v1"
            : "https://chatgpt.com/backend-api/codex",
      },
    });
    expect(model).toMatchObject({
      id,
      api,
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost:
        id === "gpt-6.2-astra"
          ? { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 }
          : { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      compat: {
        supportsTemperature: false,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        defaultThinkingLevel: "medium",
      },
      thinkingLevelMap: { off: null, minimal: "low" },
    });
  },
);

it.each(ids.flatMap((id) => [true, false].map((tools) => ({ id, tools }))))(
  "sends $id with tools=$tools without rejected sampling or none effort",
  async ({ id, tools }) => {
    const resolved = buildOpenAIProvider().resolveDynamicModel?.({
      provider: "openai",
      modelId: id,
      modelRegistry: registry,
    });
    if (!resolved) throw new Error("model must resolve before transport");
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json(
        { error: { message: "synthetic request capture", type: "invalid_request_error" } },
        { status: 400 },
      );
    });
    const model: Model = { ...resolved, api: "openai-completions" };
    const dispatch = createOpenAICompletionsTransportStreamFn();
    const result = await (
      await dispatch(
        model,
        {
          messages: [{ role: "user", content: "Call echo with synthetic value.", timestamp: 0 }],
          tools: tools
            ? [
                {
                  name: "echo",
                  description: "Echo synthetic text",
                  parameters: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                    additionalProperties: false,
                  },
                },
              ]
            : undefined,
        },
        {
          apiKey: "synthetic-key",
          reasoning: "minimal",
          temperature: 0.7,
          topP: 0.8,
          cacheRetention: "long",
        },
      )
    ).result();
    expect(result.stopReason).toBe("error");
    expect(urls).toEqual([
      tools ? "https://api.openai.com/v1/responses" : "https://api.openai.com/v1/chat/completions",
    ]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject(
      tools
        ? { model: id, reasoning: { effort: "low" }, tools: [{ type: "function", name: "echo" }] }
        : { model: id, reasoning_effort: "low" },
    );
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[0]).not.toHaveProperty("top_p");
    expect(bodies[0]).toHaveProperty("prompt_cache_options", { ttl: "30m" });
    expect(bodies[0]).not.toHaveProperty("prompt_cache_retention");
  },
);
