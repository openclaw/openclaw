import { expect, it } from "vitest";
import {
  normalizeModelCatalog,
  normalizeModelCatalogProviderRows,
} from "./model-catalog-normalize.js";
import type { ModelCatalogProvider } from "./model-catalog-types.js";

const normalize = (value: unknown, ownedProviders = [" OpenAI "]) =>
  normalizeModelCatalog(structuredClone(value), { ownedProviders: new Set(ownedProviders) });
const models = (...rows: unknown[]) =>
  normalize({ providers: { OpenAI: { models: rows } } })?.providers?.openai?.models;
const normalizeRows = (providerCatalog: ModelCatalogProvider) =>
  normalizeModelCatalogProviderRows({ provider: " OpenAI ", providerCatalog, source: "manifest" });
const windows = [
  { id: "200k", label: "200K", contextWindow: 200_000 },
  { id: "1m", label: "1M", contextWindow: 1_000_000 },
];

it("normalizes owned providers, aliases, suppression scopes and defaults", () => {
  const provider = { api: "openai-responses", baseUrl: "https://api.test", headers: { x: "y" } };
  expect(
    normalize({
      providers: {
        OpenAI: {
          ...provider,
          defaultModel: " m ",
          defaultUtilityModel: " u ",
          models: [{ id: "m" }, { id: "" }],
        },
        other: { models: [{ id: "x" }] },
      },
      aliases: {
        Alias: { provider: "OpenAI", api: "azure-openai-responses" },
        other: { provider: "other" },
      },
      suppressions: [
        {
          provider: "Alias",
          model: "m",
          reason: "retired",
          when: {
            baseUrlHosts: ["API.TEST"],
            providerConfigApiIn: ["Qwen", "ModelStudio"],
          },
        },
      ],
      discovery: { OpenAI: "static", other: "static", bad: "unknown" },
      runtimeAugment: true,
    }),
  ).toEqual({
    providers: {
      openai: { ...provider, defaultModel: "m", defaultUtilityModel: "u", models: [{ id: "m" }] },
    },
    aliases: { alias: { provider: "openai", api: "azure-openai-responses" } },
    suppressions: [
      {
        provider: "alias",
        model: "m",
        reason: "retired",
        when: {
          baseUrlHosts: ["api.test"],
          providerConfigApiIn: ["qwen", "modelstudio"],
        },
      },
    ],
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

it("sorts rows, drops invalid ids and upstream ids, merges transport and fills defaults", () => {
  const transport = { api: "openai-responses", baseUrl: "https://api.test" } as const;
  const mediaInput = { image: { tokenMode: "detail", maxBytes: 1 } } as const;
  const defaults = {
    ...transport,
    provider: "openai",
    source: "manifest",
    reasoning: false,
    status: "available",
  };
  expect(
    normalizeRows({
      ...transport,
      headers: { x: " old ", inherited: "yes" },
      models: [
        { id: "z", headers: { x: " new " }, mediaInput },
        { id: " " },
        { id: "A", upstreamModel: "other/A", input: ["image"], compat: { supportsTools: false } },
      ],
    }),
  ).toEqual([
    {
      ...defaults,
      id: "A",
      ref: "openai/A",
      mergeKey: "openai::a",
      name: "A",
      input: ["image"],
      compat: { supportsTools: false },
      headers: { x: "old", inherited: "yes" },
    },
    {
      ...defaults,
      id: "z",
      ref: "openai/z",
      mergeKey: "openai::z",
      name: "z",
      input: ["text"],
      mediaInput,
      headers: { x: "new", inherited: "yes" },
    },
  ]);
});

it.each<[string, unknown]>([
  ["supportsTools", true],
  ["sendSessionIdHeader", false],
  ["cacheControlFormat", "anthropic"],
  ["maxTokensField", "max_completion_tokens"],
  ["thinkingFormat", "openrouter"],
])("preserves compatibility %s", (field, value) => {
  const compat = { [field]: value };
  expect(models({ id: "m", compat })).toEqual([{ id: "m", compat }]);
});

it.each<[string, unknown, unknown]>([
  ["codeMode", " preferred ", "preferred"],
  ["toolSchemaProfile", " strict ", "strict"],
  ["toolCallArgumentsEncoding", " json ", "json"],
  ["visibleReasoningDetailTypes", [" summary ", ""], ["summary"]],
  ["supportedReasoningEfforts", [" low ", " high "], ["low", "high"]],
  ["supportedReasoningEfforts", [], []],
  ["unsupportedToolSchemaKeywords", [" pattern ", ""], ["pattern"]],
  ["reasoningEffortMap", { " low ": " minimal ", empty: "  " }, { low: "minimal" }],
  [
    "vercelGatewayRouting",
    { only: [" openai "], order: [" anthropic ", "", 1] },
    { only: ["openai"], order: ["anthropic"] },
  ],
])("normalizes compatibility %s", (field, raw, expected) => {
  expect(models({ id: "m", compat: { [field]: raw } })).toEqual([
    { id: "m", compat: { [field]: expected } },
  ]);
});

it("normalizes model selections, lists, prices and safe headers", () => {
  const metadata = {
    name: "GPT-5.4",
    reasoning: true,
    contextWindow: 256000,
    contextTokens: 200000,
    status: "preview",
    statusReason: "rolling out",
    replacedBy: "gpt-5.5",
    mediaInput: {
      image: {
        maxBytes: 4096,
        maxPixels: 1024,
        maxSidePx: 64,
        preferredSidePx: 32,
        tokenMode: "tile",
      },
    },
  };
  const tier = { input: 0, output: 2, cacheRead: 0, cacheWrite: 1, range: [128] };
  const bounded = { ...tier, input: 1, range: [0, 256000] };
  const cost = { input: 0, output: 2, cacheRead: 0.125, cacheWrite: 1 };
  expect(
    models({
      ...metadata,
      id: " m ",
      input: ["text", "image", "video", "document", "audio"],
      contextWindows: [
        { ...windows[1], label: " 1M " },
        { id: "bad", label: "bad", contextWindow: 0 },
        windows[0],
      ],
      contextWindowDefault: " 1m ",
      thinkingLevelMap: { off: null, minimal: " low ", max: "max", adaptive: "high" },
      replaces: [" old ", ""],
      tags: [" default ", ""],
      headers: Object.fromEntries([
        ["x", " safe "],
        ["__proto__", "bad"],
        ["constructor", "bad"],
        ["prototype", "bad"],
      ]),
      cost: {
        ...cost,
        tieredPricing: [tier, bounded, { ...tier, range: [-1] }, { input: 1, range: [0, 2] }],
      },
    }),
  ).toEqual([
    {
      ...metadata,
      id: "m",
      input: ["text", "image", "video", "document"],
      contextWindows: windows,
      contextWindowDefault: "1m",
      thinkingLevelMap: { off: null, minimal: "low", max: "max" },
      replaces: ["old"],
      tags: ["default"],
      headers: { x: "safe" },
      cost: { ...cost, tieredPricing: [tier, bounded] },
    },
  ]);
});

it("normalizes routing and drops malformed compatibility fields", () => {
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
  expect(
    models(
      {
        id: "m",
        compat: {
          openRouterRouting: {
            ...routing,
            order: [" openai ", ""],
            only: [" anthropic ", "", 1],
            ignore: [" bad "],
            quantizations: [" fp8 "],
            sort: { by: " throughput ", partition: null },
            max_price: { ...routing.max_price, prompt: " 0.5 " },
          },
        },
      },
      {
        id: "invalid",
        compat: {
          supportsStore: "yes",
          unknownFlag: true,
          openRouterRouting: { require_parameters: "no" },
          vercelGatewayRouting: { only: "openai" },
        },
      },
    ),
  ).toEqual([{ id: "m", compat: { openRouterRouting: routing } }, { id: "invalid" }]);
});

it.each([null, { suppressions: [{ provider: "openai" }] }, { modelsDev: { openai: " " } }])(
  "rejects an empty or invalid catalog: %j",
  (value) => expect(normalize(value)).toBeUndefined(),
);

it("drops the selection tuple with an undeclared default", () => {
  const contextWindows = Array.from({ length: 20 }, (_, i) => ({
    id: `window-${i}`,
    label: `Window ${i}`,
    contextWindow: 20 - i,
  }));
  const [row] = normalizeRows({
    models: [{ id: "m", contextWindows, contextWindowDefault: "missing" }],
  });
  expect([row?.contextWindows, row?.contextWindowDefault]).toEqual([undefined, undefined]);
});

it("retains ownership without static models and rejects invalid credential scope", () => {
  const provider = { authScope: "plugin", models: [] };
  expect(normalize({ providers: { fixture: provider } }, ["fixture"])?.providers?.fixture).toEqual(
    provider,
  );
  expect(() =>
    normalize({ providers: { fixture: { authScope: "global", models: [{ id: "m" }] } } }, [
      "fixture",
    ]),
  ).toThrow("credential ownership");
});

it("inherits provider family unless overridden and drops malformed families", () => {
  const providers = normalize(
    {
      providers: {
        OpenAI: {
          family: " OpenAI ",
          models: [{ id: "m" }, { id: "oss", family: "Meta" }, { id: "bad", family: 7 }],
        },
        Router: { family: "open ai", models: [{ id: "x", family: "a".repeat(65) }] },
      },
    },
    ["openai", "router"],
  )?.providers;
  expect(providers?.openai?.family).toBe("openai");
  expect(providers?.router).toEqual({ models: [{ id: "x" }] });
  const families = (catalog: ModelCatalogProvider | undefined) =>
    Object.fromEntries(normalizeRows(catalog ?? { models: [] }).map((row) => [row.id, row.family]));
  expect(families(providers?.openai)).toEqual({ m: "openai", oss: "meta", bad: "openai" });
  expect(families(providers?.router)).toEqual({ x: undefined });
});
