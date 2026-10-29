import { expect, it, vi } from "vitest";
import {
  normalizeModelCatalog,
  normalizeModelCatalogProviderRows,
} from "./model-catalog-normalize.js";
import type { ModelCatalogProvider } from "./model-catalog-types.js";
import {
  parseRemoteModelCatalogBundle as parseV1,
  parseRemoteModelCatalogBundleV2 as parseV2,
  parseRemoteModelCatalogBundleV3 as parseV3,
  validateAndSanitizeRemoteModelCatalogBundle as sanitizeV1,
  validateAndSanitizeRemoteModelCatalogBundleV2 as sanitizeV2,
  validateAndSanitizeRemoteModelCatalogBundleV3 as sanitizeV3,
} from "./remote-catalog-bundle.js";

const normalize = (value: unknown, ownedProviders = [" OpenAI "]) =>
  normalizeModelCatalog(structuredClone(value), { ownedProviders: new Set(ownedProviders) });
const normalizeModels = (...rows: unknown[]) =>
  normalize({ providers: { OpenAI: { models: rows } } })?.providers?.openai?.models;
const normalizeRows = (providerCatalog: ModelCatalogProvider) =>
  normalizeModelCatalogProviderRows({ provider: " OpenAI ", providerCatalog, source: "manifest" });
const windows = [
  { id: "200k", label: "200K", contextWindow: 200_000 },
  { id: "1m", label: "1M", contextWindow: 1_000_000 },
];

const wire = { api: "openai-responses", baseUrl: "https://api.test", headers: { x: "y" } };
const scope = { baseUrlHosts: ["api.test"], providerConfigApiIn: ["qwen", "modelstudio"] };
const suppression = { provider: "alias", model: "m", reason: "retired", when: scope };
const utility = { defaultUtilityModel: "u", defaultUtilityModels: { vendor: "vendor/small" } };
it.each<[string, unknown, unknown]>([
  [
    "providers",
    {
      OpenAI: {
        ...wire,
        defaultModel: " m ",
        defaultUtilityModel: " u ",
        defaultUtilityModels: { " Vendor ": " vendor/small ", blank: " " },
        models: [{ id: "m" }, { id: "" }],
      },
      other: { models: [{ id: "x" }] },
    },
    { openai: { ...wire, defaultModel: "m", ...utility, models: [{ id: "m" }] } },
  ],
  [
    "aliases",
    { Alias: { provider: "OpenAI", api: "azure-openai-responses" }, other: { provider: "other" } },
    { alias: { provider: "openai", api: "azure-openai-responses" } },
  ],
  [
    "suppressions",
    [
      {
        ...suppression,
        provider: "Alias",
        when: { baseUrlHosts: ["API.TEST"], providerConfigApiIn: ["Qwen", "ModelStudio"] },
      },
    ],
    [suppression],
  ],
  ["discovery", { OpenAI: "static", other: "static", bad: "unknown" }, { openai: "static" }],
  ["runtimeAugment", true, true],
])("normalizes catalog %s within provider ownership", (field, raw, expected) => {
  expect(normalize({ [field]: raw })).toEqual({ [field]: expected });
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
  const image = { maxBytes: 4096, maxPixels: 1024, maxSidePx: 64, preferredSidePx: 32 };
  const mediaInput = { image: { ...image, tokenMode: "detail" } } as const;
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

it.each<[string, unknown, unknown?]>([
  ["supportsTools", true],
  ["sendSessionIdHeader", false],
  ["cacheControlFormat", "anthropic"],
  ["maxTokensField", "max_completion_tokens"],
  ["thinkingFormat", "openrouter"],
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
])("normalizes compatibility %s", (field, raw, expected = raw) => {
  expect(normalizeModels({ id: "m", compat: { [field]: raw } })).toEqual([
    { id: "m", compat: { [field]: expected } },
  ]);
});

it("normalizes model selections, lists, prices and safe headers", () => {
  const tier = { input: 0, output: 2, cacheRead: 0, cacheWrite: 1, range: [128] };
  const bounded = { ...tier, input: 1, range: [0, 256000] };
  const cost = { input: 0, output: 2, cacheRead: 0.125, cacheWrite: 1 };
  expect(
    normalizeModels({
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
    normalizeModels(
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
  const [row] = normalizeRows({
    models: [{ id: "m", contextWindows: windows, contextWindowDefault: "missing" }],
  });
  expect([row?.contextWindows, row?.contextWindowDefault]).toEqual([undefined, undefined]);
});

it("retains ownership without static models and rejects invalid credential scope", () => {
  const provider = { authScope: "plugin", models: [] };
  expect(normalize({ providers: { fixture: provider } }, ["fixture"])?.providers?.fixture).toEqual(
    provider,
  );
  expect(() => normalize({ providers: { fixture: { authScope: "global" } } }, ["fixture"])).toThrow(
    "credential ownership",
  );
});

it("normalizes declared families and drops malformed families", () => {
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
  expect(providers).toEqual({
    openai: {
      family: "openai",
      models: [{ id: "m" }, { id: "oss", family: "meta" }, { id: "bad" }],
    },
    router: { models: [{ id: "x" }] },
  });
});

const transport = { baseUrl: "https://evil.test", headers: { Authorization: "bad" } };
const cleanProvider = { models: [{ id: "claude-test" }] };
const validBundle = {
  schemaVersion: 1,
  generatedAt: 1_753_500_000_000,
  sourceCommit: "abc123",
  providers: { anthropic: cleanProvider },
};

it("accepts v1 metadata while deeply stripping transport overrides", () => {
  const provider = {
    defaultModel: "claude-test",
    models: [{ id: "claude-test", compat: { nested: {} } }],
  };
  const pricing = { "openai/gpt-external": { input: 2.5, output: 10, cacheRead: 1.25 } };
  const parsed = sanitizeV1({
    ...validBundle,
    providers: {
      anthropic: {
        ...provider,
        ...transport,
        models: [{ id: "claude-test", ...transport, compat: { nested: transport } }],
      },
    },
    pricing,
  });
  expect(parsed.providers.anthropic).toEqual(provider);
  expect(parsed.pricing).toEqual(pricing);
});
const knownPrice = { status: "known", currency: "USD", unit: "million_tokens" };
const modelV2 = (id: string, provider = "first", pricing: unknown = { status: "unknown" }) => ({
  id,
  provider,
  pricing,
});
const firstModel = modelV2("vendor/model");
const validBundleV2 = {
  schemaVersion: 2,
  generatedAt: validBundle.generatedAt,
  sourceCommit: "abc123",
  providers: { first: {}, second: {} },
  models: [firstModel, modelV2("second-only", "second")],
};
const versions = [
  [1, parseV1, sanitizeV1, validBundle],
  [2, parseV2, sanitizeV2, validBundleV2],
] as const;
const v1Provider = (patch: Record<string, unknown>) => ({
  providers: { anthropic: { ...cleanProvider, ...patch } },
});
const v1Models = (...models: unknown[]) => v1Provider({ models });
const rowsFor = (version: number, models: unknown[]) =>
  version === 1 ? { providers: { first: { models } } } : { models };

type Rejection = [Record<string, unknown>, string?];
const invalidV1: Rejection[] = [
  [{ schemaVersion: 2 }],
  [{ generatedAt: 0 }],
  [
    { generatedAt: Date.now() + 2 * 24 * 60 * 60_000 },
    "generatedAt is implausibly far in the future",
  ],
  [v1Models()],
  [v1Models({ id: " duplicate " }, { id: "duplicate" }), "duplicate model id: duplicate"],
  [{ pricing: { "openai/bad": { input: -1, output: 2 } } }],
  [{ pricing: { "openai/bad": { input: 1, output: 2, baseUrl: "https://bad.test" } } }],
  [
    v1Models({ id: "bad", contextWindows: windows, contextWindowDefault: "missing" }),
    "contextWindowDefault must reference a declared contextWindows option",
  ],
  [v1Provider({ recommendedModels: ["claude-test"] }), "recommendedModels"],
];
const invalidV2: Rejection[] = [
  [{ models: [firstModel, { ...firstModel, id: " vendor/model " }] }, "duplicate provider/model"],
  [{ models: [{ ...firstModel, provider: "missing" }] }, "undeclared model provider"],
  [{ models: [{ ...firstModel, baseUrl: "https://bad.test" }] }, "baseUrl"],
  [{ models: [{ ...firstModel, contextWindowDefault: "missing" }] }, "contextWindowDefault"],
  [{ models: [{ ...firstModel, pricing: { status: "unknown", input: 0 } }] }, "input"],
  [{ models: [{ ...firstModel, pricing: knownPrice }] }, "known pricing must contain rates"],
  [{ models: [{ ...firstModel, pricing: { ...knownPrice, input: -1 } }] }, "input"],
  [{ pricing: {} }],
];
for (const recommendedModels of [["vendor/model", " vendor/model "], [" "], ["second-only"]]) {
  invalidV2.push([{ providers: { first: { recommendedModels }, second: {} } }]);
}
for (const pricing of [
  { "vendor/model": { input: 1, output: 2 } },
  { model: { input: 1, output: 2, source: "x" } },
]) {
  for (const field of ["upstreamPricing", "providerPricing"]) {
    invalidV2.push([{ [field]: pricing }]);
  }
}
it.each([versions[0], versions[1]])(
  "rejects malformed v%i catalogs",
  (version, parse, _sanitize, bundle) => {
    const cases = version === 1 ? invalidV1 : invalidV2;
    for (const [patch, error] of cases) {
      expect(() => parse({ ...bundle, ...patch }), JSON.stringify(patch)).toThrow(error);
    }
  },
);

it.each([versions[0], versions[1]])(
  "ingests v%i rows independently and warns once per affected row",
  (version, _parse, sanitize, base) => {
    const warn = vi.fn();
    const rows = [
      { id: "kept", input: ["text", "audio", "image", "future", "video", "document"] },
      { id: "future-only", input: ["audio"] },
      { id: "bad-input", input: ["text", 42] },
      { id: "bad-api", api: "future-api" },
      { id: "bad-limit", contextWindow: -1 },
      { id: "bad-context", contextWindowDefault: "missing" },
      { id: " " },
      {},
      { id: "kept" },
      { id: "last", input: ["text"] },
    ];
    const patch =
      version === 1
        ? {
            providers: {
              first: { models: rows },
              second: { models: [{ id: "kept" }] },
              empty: { models: [] },
            },
          }
        : {
            providers: { first: { recommendedModels: ["bad-api", "kept"] }, second: {} },
            models: [
              ...rows.map((row) =>
                Object.assign({}, row, { provider: "first", pricing: { status: "unknown" } }),
              ),
              modelV2("kept", "second"),
            ],
          };
    const bundle = sanitize({ ...base, ...patch }, warn);
    const models =
      bundle.schemaVersion === 1 ? (bundle.providers.first?.models ?? []) : bundle.models;
    expect(models.slice(0, 2).map(({ id, input }) => ({ id, input }))).toEqual([
      { id: "kept", input: ["text", "image", "video", "document"] },
      { id: "last", input: ["text"] },
    ]);
    expect(
      bundle.schemaVersion === 1 ? bundle.providers.second?.models : models.slice(2),
    ).toMatchObject([{ id: "kept" }]);
    if (bundle.schemaVersion === 2) {
      expect(bundle.providers.first?.recommendedModels).toEqual(["kept"]);
    } else {
      expect(bundle.providers).not.toHaveProperty("empty");
    }
    expect(warn).toHaveBeenCalledTimes(9);
    warn.mockClear();
    expect(sanitize(bundle, warn)).toEqual(bundle);
    expect(warn).not.toHaveBeenCalled();
  },
);

it.each([versions[0], versions[1]])(
  "rejects invalid v%i envelopes and catalogs with no usable rows",
  (version, _parse, sanitize, bundle) => {
    for (const patch of [
      { sourceCommit: undefined },
      { generatedAt: "today" },
      { providers: null },
    ]) {
      expect(() => sanitize({ ...bundle, ...patch })).toThrow();
    }
    for (const models of [[], [{ id: "" }]]) {
      expect(() => sanitize({ ...bundle, ...rowsFor(version, models) }, vi.fn())).toThrow(
        "no valid models",
      );
    }
  },
);

it("strips v2 transport metadata while preserving transport-like provider identities", () => {
  const models = [
    {
      ...firstModel,
      provider: "headers",
      contextWindows: windows,
      contextWindowDefault: "1m",
      compat: { supportsTools: true, nested: transport },
    },
    { ...validBundleV2.models[1], provider: "baseUrl" },
  ];
  const bundle = sanitizeV2({ ...validBundleV2, providers: { headers: {}, baseUrl: {} }, models });
  expect(Object.keys(bundle.providers)).toEqual(["headers", "baseUrl"]);
  expect(bundle.models.map((model) => model.provider)).toEqual(["headers", "baseUrl"]);
  expect(bundle.models[0]).toEqual({ ...models[0], compat: { supportsTools: true, nested: {} } });
  expect(() => parseV2(bundle)).not.toThrow();
});

it("negotiates task metadata only on v3 and rejects malformed declarations per row", () => {
  const inference = { chat: false, decision: { protocol: "fixture", input: ["text"] } };
  const native = { ...firstModel, inference, compat: { nested: transport } };
  const candidate = {
    ...validBundleV2,
    schemaVersion: 3,
    providers: { first: { recommendedModels: [native.id] } },
    models: [native],
  };
  expect(() => parseV2(candidate)).toThrow();
  expect(() => parseV2({ ...candidate, schemaVersion: 2 })).toThrow();
  expect(parseV3(candidate).models[0]?.inference).toEqual(inference);
  const warn = vi.fn();
  const invalid = {
    ...native,
    id: "invalid",
    inference: { ...inference, decision: { ...inference.decision, protocol: "invalid protocol" } },
  };
  const admitted = sanitizeV3({ ...candidate, models: [native, invalid] }, warn);
  expect(admitted.models).toHaveLength(1);
  expect(admitted.models[0]).toMatchObject({ inference, compat: { nested: {} } });
  expect(admitted.providers.first?.recommendedModels).toEqual([]);
  expect(warn).toHaveBeenCalledOnce();
});

it("limits configured-origin discovery to owned runtime catalogs", () => {
  expect(
    normalize(
      {
        discovery: { live: "runtime", cached: "refreshable", fixed: "static", other: "runtime" },
        configuredEndpointDiscovery: [" LIVE ", "live", "cached", "fixed", "other", "missing"],
      },
      ["live", "cached", "fixed", "missing"],
    ),
  ).toEqual({
    discovery: { live: "runtime", cached: "refreshable", fixed: "static" },
    configuredEndpointDiscovery: ["live"],
  });
});
