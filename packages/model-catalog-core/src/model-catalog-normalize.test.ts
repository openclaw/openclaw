import { expect, it } from "vitest";
import {
  normalizeModelCatalog,
  normalizeModelCatalogProviderRows,
} from "./model-catalog-normalize.js";
import type { ModelCatalogModel, ModelCatalogProvider } from "./model-catalog-types.js";

const normalize = (value: unknown, ownedProviders = [" OpenAI "]) =>
  normalizeModelCatalog(structuredClone(value), { ownedProviders: new Set(ownedProviders) });
const normalizeModels = (models: unknown[]) =>
  normalize({ providers: { OpenAI: { models } } })?.providers?.openai?.models;
const normalizeRows = (providerCatalog: ModelCatalogProvider) =>
  normalizeModelCatalogProviderRows({
    provider: " OpenAI ",
    providerCatalog: structuredClone(providerCatalog),
    source: "manifest",
  });

const windows = [
  { id: "200k", label: "200K", contextWindow: 200_000 },
  { id: "1m", label: "1M", contextWindow: 1_000_000 },
];

it("normalizes catalog ownership, aliases, suppressions, and row fields", () => {
  const model = { id: "gpt-5.4" };
  const provider = {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    headers: { "x-provider": "openai" },
    defaultModel: "gpt-5.4",
    defaultUtilityModel: "gpt-5.6-luna",
  };
  const suppression = {
    provider: "azure-openai-responses",
    model: "gpt-5.3-codex-spark",
    reason: "not available",
    when: {
      baseUrlHosts: ["coding-intl.dashscope.aliyuncs.com"],
      providerConfigApiIn: ["qwen", "modelstudio"],
    },
  };
  expect(
    normalize({
      providers: {
        OpenAI: {
          ...provider,
          defaultModel: " gpt-5.4 ",
          defaultUtilityModel: " gpt-5.6-luna ",
          models: [model, { id: "" }],
        },
        anthropic: { models: [{ id: "claude-sonnet-4.6" }] },
      },
      aliases: {
        "Azure-OpenAI-Responses": { provider: "OpenAI", api: "azure-openai-responses" },
        "anthropic-alias": { provider: "anthropic" },
      },
      suppressions: [
        {
          ...suppression,
          provider: "Azure-OpenAI-Responses",
          when: {
            baseUrlHosts: ["CODING-INTL.DASHSCOPE.ALIYUNCS.COM"],
            providerConfigApiIn: ["Qwen", "ModelStudio"],
          },
        },
      ],
      discovery: { OpenAI: "static", anthropic: "static", bad: "unknown" },
      runtimeAugment: true,
    }),
  ).toEqual({
    providers: { openai: { ...provider, models: [model] } },
    aliases: { "azure-openai-responses": { provider: "openai", api: "azure-openai-responses" } },
    suppressions: [suppression],
    discovery: { openai: "static" },
    runtimeAugment: true,
  });
});

it("keeps only explicit owned models.dev mappings without creating provider rows", () => {
  const aliases = { alias: { provider: "example" } };
  expect(
    normalize(
      {
        modelsDev: {
          " Example ": " Upstream-ID ",
          other: "other-source",
          alias: "alias-source",
          Constructor: "blocked-source",
        },
        providers: { example: { models: [] } },
        aliases,
      },
      [" EXAMPLE ", "constructor"],
    ),
  ).toEqual({ modelsDev: { example: "Upstream-ID" }, aliases });
});

it("normalizes, sorts, and filters provider rows", () => {
  const model = {
    id: "GPT-5.4",
    headers: { "x-model": "gpt-5.4" },
    input: ["image"],
    compat: { supportsTools: false },
  } satisfies ModelCatalogModel;
  const transport = { baseUrl: "https://api.openai.com/v1", api: "openai-responses" as const };
  const mediaInput = { image: { tokenMode: "detail" as const, maxBytes: 1 } };
  const defaults = {
    ...transport,
    source: "manifest",
    provider: "openai",
    reasoning: false,
    status: "available",
  };
  expect(
    normalizeRows({
      ...transport,
      headers: { "x-provider": "openai", "x-override": " old " },
      models: [
        { id: "z-model", headers: { "x-override": " new " }, mediaInput },
        { id: "  " },
        { ...model, upstreamModel: "other/gpt-5.4" },
      ],
    }),
  ).toEqual([
    {
      ...model,
      ...defaults,
      ref: "openai/GPT-5.4",
      mergeKey: "openai::gpt-5.4",
      name: "GPT-5.4",
      headers: { "x-provider": "openai", "x-override": "old", "x-model": "gpt-5.4" },
    },
    {
      id: "z-model",
      ...defaults,
      ref: "openai/z-model",
      mergeKey: "openai::z-model",
      name: "z-model",
      input: ["text"],
      mediaInput,
      headers: { "x-provider": "openai", "x-override": "new" },
    },
  ]);
});

it("normalizes complete model fields, provider routing, pricing, and image limits", () => {
  const tier = { input: 0, output: 2, cacheRead: 0, cacheWrite: 1, range: [128] };
  const boundedTier = { input: 1, output: 2, cacheRead: 0, cacheWrite: 1, range: [0, 256000] };
  const routing = {
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: "deny",
    zdr: true,
    enforce_distillable_text: true,
    order: ["openai"],
    only: ["anthropic"],
    ignore: ["bad"],
    quantizations: ["fp8"],
    sort: { by: "throughput", partition: null },
    max_price: { prompt: "0.5", completion: 2, image: 0, audio: 3, request: 4 },
    preferred_min_throughput: { p50: 10, p75: 20, p90: 30, p99: 40 },
    preferred_max_latency: 1,
  };
  const model = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-completions",
    baseUrl: "https://proxy.example/v1",
    headers: { "x-safe": "value" },
    input: ["text", "image", "video", "document"],
    reasoning: true,
    contextWindow: 256000,
    contextTokens: 200000,
    parameterCount: 70_000_000_000,
    maxTokens: 128000,
    contextWindows: windows,
    contextWindowDefault: "1m",
    thinkingLevelMap: { off: null, minimal: "low", max: "max" },
    status: "preview",
    statusReason: "rolling out",
    replaces: ["gpt-5.3"],
    replacedBy: "gpt-5.5",
    tags: ["default"],
    cost: {
      input: 0,
      output: 2,
      cacheRead: 0.125,
      cacheWrite: 1,
      tieredPricing: [tier, boundedTier],
    },
    mediaInput: {
      image: {
        maxBytes: 4096,
        maxPixels: 1024,
        maxSidePx: 64,
        preferredSidePx: 32,
        tokenMode: "tile",
      },
    },
    compat: {
      supportsTools: true,
      codeMode: "preferred",
      cacheControlFormat: "anthropic",
      zaiToolStream: true,
      sendSessionAffinityHeaders: true,
      sendSessionIdHeader: false,
      supportsEagerToolInputStreaming: false,
      supportsLongCacheRetention: true,
      supportsResponsesContinuation: true,
      supportsJsonSchemaResponseFormat: true,
      requiresReasoningContentOnAssistantMessages: true,
      supportsPromptCacheKey: true,
      toolSchemaProfile: "strict",
      toolCallArgumentsEncoding: "json",
      visibleReasoningDetailTypes: ["summary"],
      supportedReasoningEfforts: ["low", "high"],
      unsupportedToolSchemaKeywords: ["pattern"],
      reasoningEffortMap: { low: "minimal" },
      maxTokensField: "max_completion_tokens",
      thinkingFormat: "openrouter",
      openRouterRouting: routing,
      vercelGatewayRouting: { only: ["openai"], order: ["anthropic"] },
    },
  };
  const raw = {
    ...model,
    id: " gpt-5.4 ",
    input: [...model.input, "audio"],
    contextWindows: [
      { ...windows[1], label: " 1M " },
      { id: "invalid", label: "Invalid", contextWindow: 0 },
      { ...windows[0], label: " 200K " },
    ],
    contextWindowDefault: " 1m ",
    thinkingLevelMap: { ...model.thinkingLevelMap, minimal: " low ", adaptive: "high" },
    replaces: [" gpt-5.3 ", ""],
    tags: [" default ", ""],
    headers: Object.fromEntries([
      ["x-safe", " value "],
      ["__proto__", "polluted"],
      ["constructor", "polluted"],
      ["prototype", "polluted"],
    ]),
    cost: {
      ...model.cost,
      tieredPricing: [tier, boundedTier, { ...tier, range: [-1] }, { input: 1, range: [0, 2] }],
    },
    compat: {
      ...model.compat,
      codeMode: " preferred ",
      supportsStore: "yes",
      unknownFlag: true,
      toolSchemaProfile: " strict ",
      toolCallArgumentsEncoding: " json ",
      visibleReasoningDetailTypes: [" summary ", ""],
      supportedReasoningEfforts: [" low ", " high "],
      unsupportedToolSchemaKeywords: [" pattern ", ""],
      reasoningEffortMap: { " low ": " minimal ", empty: "  " },
      openRouterRouting: {
        ...routing,
        order: [" openai ", ""],
        only: [" anthropic ", "", 1],
        ignore: [" bad "],
        quantizations: [" fp8 "],
        sort: { by: " throughput ", partition: null },
        max_price: { ...routing.max_price, prompt: " 0.5 " },
      },
      vercelGatewayRouting: { only: [" openai "], order: [" anthropic ", "", 1] },
    },
  };
  expect(
    normalizeModels([
      raw,
      {
        id: "invalid",
        compat: {
          openRouterRouting: { require_parameters: "no" },
          vercelGatewayRouting: { only: "openai" },
        },
      },
    ]),
  ).toEqual([model, { id: "invalid" }]);
});

it("retains an explicitly empty supported reasoning effort list", () => {
  expect(
    normalizeModels([{ id: "reasoner", compat: { supportedReasoningEfforts: [] } }])?.[0]?.compat,
  ).toEqual({ supportedReasoningEfforts: [] });
});

it.each([
  { name: "non-record catalog", value: null },
  { name: "invalid suppression", value: { suppressions: [{ provider: "openai" }] } },
  { name: "blank models.dev source", value: { modelsDev: { openai: "  " } } },
])("rejects a $name instead of publishing an empty catalog", ({ value }) => {
  expect(normalize(value)).toBeUndefined();
});

it("drops the selection tuple with an undeclared default", () => {
  const contextWindows = Array.from({ length: 20 }, (_, index) => ({
    id: `window-${index}`,
    label: `Window ${index}`,
    contextWindow: 20 - index,
  }));
  const [row] = normalizeRows({
    models: [{ id: "model", contextWindows, contextWindowDefault: "missing" }],
  });
  expect([row?.contextWindows, row?.contextWindowDefault]).toEqual([undefined, undefined]);
});

it("retains ownership for providers without static model rows", () => {
  const provider = { authScope: "plugin", models: [] };
  expect(normalize({ providers: { fixture: provider } }, ["fixture"])?.providers?.fixture).toEqual(
    provider,
  );
});
it("rejects invalid ownership rather than downgrading to default agent scope", () => {
  expect(() =>
    normalize({ providers: { fixture: { authScope: "global", models: [{ id: "model" }] } } }, [
      "fixture",
    ]),
  ).toThrow("credential ownership");
});
