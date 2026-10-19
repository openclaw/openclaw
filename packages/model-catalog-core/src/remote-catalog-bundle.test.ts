import { expect, it, vi } from "vitest";
import {
  parseRemoteModelCatalogBundle as parseV1,
  parseRemoteModelCatalogBundleV2 as parseV2,
  parseRemoteModelCatalogBundleV3 as parseV3,
  validateAndSanitizeRemoteModelCatalogBundle as sanitizeV1,
  validateAndSanitizeRemoteModelCatalogBundleV2 as sanitizeV2,
  validateAndSanitizeRemoteModelCatalogBundleV3 as sanitizeV3,
} from "./remote-catalog-bundle.js";

const contextWindows = [
  { id: "200k", label: "200K", contextWindow: 200_000 },
  { id: "1m", label: "1M", contextWindow: 1_000_000 },
];
const transport = { baseUrl: "https://evil.test", headers: { Authorization: "bad" } };
const cleanModel = {
  id: "claude-test",
  input: ["text", "image", "video"],
  contextWindows,
  contextWindowDefault: "1m",
  compat: { nested: {} },
};
const cleanProvider = {
  defaultModel: "claude-test",
  defaultUtilityModel: "claude-test",
  models: [cleanModel],
};
const validBundle = {
  schemaVersion: 1,
  generatedAt: 1_753_500_000_000,
  minVersion: "2026.7.0",
  sourceCommit: "abc123",
  providers: {
    anthropic: {
      ...cleanProvider,
      ...transport,
      models: [{ ...cleanModel, ...transport, compat: { nested: transport } }],
    },
  },
  pricing: { "openai/gpt-external": { input: 2.5, output: 10, cacheRead: 1.25 } },
};
const knownPrice = { status: "known", currency: "USD", unit: "million_tokens" };
const firstModel = {
  id: "vendor/model",
  provider: "first",
  input: ["text", "video"],
  pricing: { ...knownPrice, source: "native-feed", input: 0, output: 0 },
};
const validBundleV2 = {
  schemaVersion: 2,
  generatedAt: validBundle.generatedAt,
  sourceCommit: "abc123",
  providers: {
    first: { defaultModel: "vendor/model" },
    second: { defaultUtilityModel: "vendor/model" },
  },
  models: [firstModel, { id: "vendor/model", provider: "second", pricing: { status: "unknown" } }],
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
    v1Models({ id: "bad", contextWindows, contextWindowDefault: "missing" }),
    "contextWindowDefault must reference a declared contextWindows option",
  ],
  [v1Provider({ recommendedModels: ["claude-test"] }), "recommendedModels"],
  [validBundleV2],
];
const invalidV2: Rejection[] = [
  [{ models: [firstModel, { ...firstModel, id: " vendor/model " }] }, "duplicate provider/model"],
  [{ models: [{ ...firstModel, provider: "missing" }] }, "undeclared model provider"],
  [{ models: [{ ...firstModel, baseUrl: "https://bad.test" }] }, "baseUrl"],
  [{ models: [{ ...firstModel, contextWindowDefault: "missing" }] }, "contextWindowDefault"],
  [{ models: [{ ...firstModel, pricing: { status: "unknown", input: 0 } }] }, "input"],
  [{ models: [{ ...firstModel, pricing: knownPrice }] }, "known pricing must contain rates"],
  [{ models: [{ ...firstModel, pricing: { ...firstModel.pricing, input: -1 } }] }, "input"],
  [validBundle],
  [{ schemaVersion: 3 }],
  [{ pricing: {} }],
];
for (const recommendedModels of [
  ["missing"],
  ["vendor/model", " vendor/model "],
  [" "],
  ["second-only"],
]) {
  invalidV2.push([
    {
      providers: { first: { recommendedModels }, second: {} },
      models: [
        ...validBundleV2.models,
        { id: "second-only", provider: "second", pricing: { status: "unknown" } },
      ],
    },
  ]);
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

it("accepts v1 metadata while deeply stripping transport overrides", () => {
  const parsed = sanitizeV1(validBundle);
  expect(parsed.providers.anthropic).toEqual(cleanProvider);
  expect(parsed.pricing).toEqual(validBundle.pricing);
});

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
              { id: "kept", provider: "second", pricing: { status: "unknown" } },
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
    const rowPath = version === 1 ? "providers.first.models" : "models";
    expect([warn.mock.calls.length, warn.mock.calls[0], warn.mock.calls[2]]).toEqual([
      9,
      [`remote model catalog: dropped unknown input modalities from ${rowPath}.0 (kept)`],
      [`remote model catalog: skipped invalid row ${rowPath}.2 (bad-input)`],
    ]);
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

it("preserves v2 recommendations, scoped identities, and all pricing states", () => {
  const tiers = [
    { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0, range: [0, 200_000] },
    { input: 4, output: 12, cacheRead: 1, cacheWrite: 0, range: [200_000] },
  ];
  const pricing = [
    { ...knownPrice, input: 2 },
    { ...knownPrice, tieredPricing: tiers },
    { status: "unavailable", source: "native-feed" },
  ];
  const models = [
    ...validBundleV2.models,
    { id: "other", provider: "first", pricing: { status: "unknown" } },
    ...pricing.map((price, index) => ({ id: `model-${index}`, provider: "first", pricing: price })),
  ];
  const providers = {
    ...validBundleV2.providers,
    first: { ...validBundleV2.providers.first, recommendedModels: ["other", "vendor/model"] },
  };
  expect(
    parseV2({
      ...validBundleV2,
      models,
      providers: {
        ...providers,
        first: { ...providers.first, recommendedModels: [" other ", "vendor/model"] },
      },
    }),
  ).toEqual({ ...validBundleV2, models, providers });
});

it("strips v2 transport metadata while preserving transport-like provider identities", () => {
  const models = [
    {
      ...firstModel,
      provider: "headers",
      contextWindows,
      contextWindowDefault: "1m",
      compat: { supportsTools: true, nested: transport },
    },
    { ...validBundleV2.models[1], provider: "baseUrl" },
  ];
  const bundle = sanitizeV2({
    ...validBundleV2,
    providers: { headers: {}, baseUrl: {} },
    models,
  });
  expect(Object.keys(bundle.providers)).toEqual(["headers", "baseUrl"]);
  expect(bundle.models.map((model) => model.provider)).toEqual(["headers", "baseUrl"]);
  expect(bundle.models[0]).toEqual({
    ...models[0],
    compat: { supportsTools: true, nested: {} },
  });
  expect(() => parseV2(bundle)).not.toThrow();
});

it("negotiates task metadata only on v3 and rejects malformed declarations per row", () => {
  const inference = {
    chat: false,
    decision: {
      protocol: "fixture.decisions",
      input: ["text"],
      questions: { boolean: { probabilities: "boolean", abstention: false } },
      billing: { unit: "tokens", source: "provider-docs", usdPerMillion: { input: 0, output: 0 } },
    },
  };
  const native = { ...firstModel, inference, compat: { nested: transport } };
  const candidate = { ...validBundleV2, schemaVersion: 3, models: [native] };
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
  expect(warn).toHaveBeenCalledOnce();
});
