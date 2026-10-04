import { expect, it } from "vitest";
import {
  parseRemoteModelCatalogBundle,
  parseRemoteModelCatalogBundleV2,
  validateAndSanitizeRemoteModelCatalogBundle,
  validateAndSanitizeRemoteModelCatalogBundleV2,
} from "./remote-catalog-bundle.js";

const contextWindows = [
  { id: "200k", label: "200K", contextWindow: 200_000 },
  { id: "1m", label: "1M", contextWindow: 1_000_000 },
];
const transport = { baseUrl: "https://evil.test", headers: { Authorization: "bad" } };
const validBundle = {
  schemaVersion: 1,
  generatedAt: 1_753_500_000_000,
  minVersion: "2026.7.0",
  sourceCommit: "abc123",
  providers: {
    anthropic: {
      ...transport,
      defaultModel: "claude-test",
      defaultUtilityModel: "claude-test",
      models: [
        {
          id: "claude-test",
          ...transport,
          contextWindows,
          contextWindowDefault: "1m",
          compat: { nested: transport },
        },
      ],
    },
  },
  pricing: { "openai/gpt-external": { input: 2.5, output: 10, cacheRead: 1.25 } },
};
const knownPrice = { status: "known", currency: "USD", unit: "million_tokens" };
const firstModel = {
  id: "vendor/model",
  provider: "first",
  input: ["text"],
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

type Rejection = [Record<string, unknown>, string?];
const invalidV1: Rejection[] = [
  [{ schemaVersion: 2 }],
  [{ generatedAt: 0 }],
  [
    { generatedAt: Date.now() + 2 * 24 * 60 * 60_000 },
    "generatedAt is implausibly far in the future",
  ],
  [{ providers: { anthropic: { models: [] } } }],
  [
    { providers: { anthropic: { models: [{ id: " duplicate " }, { id: "duplicate" }] } } },
    "duplicate model id: duplicate",
  ],
  [{ pricing: { "openai/bad": { input: -1, output: 2 } } }],
  [{ pricing: { "openai/bad": { input: 1, output: 2, baseUrl: "https://bad.test" } } }],
  [
    {
      providers: {
        anthropic: {
          models: [
            { id: "bad-default", contextWindows: [contextWindows[0]], contextWindowDefault: "1m" },
          ],
        },
      },
    },
    "contextWindowDefault must reference a declared contextWindows option",
  ],
  [
    {
      providers: {
        anthropic: { ...validBundle.providers.anthropic, recommendedModels: ["claude-test"] },
      },
    },
    "recommendedModels",
  ],
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
it.each([
  { version: 1, parse: parseRemoteModelCatalogBundle, bundle: validBundle, cases: invalidV1 },
  { version: 2, parse: parseRemoteModelCatalogBundleV2, bundle: validBundleV2, cases: invalidV2 },
])("rejects malformed v$version catalogs", ({ parse, bundle, cases }) => {
  for (const [patch, error] of cases) {
    expect(() => parse({ ...bundle, ...patch }), JSON.stringify(patch)).toThrow(error);
  }
});

it("accepts v1 metadata while deeply stripping transport overrides", () => {
  const parsed = validateAndSanitizeRemoteModelCatalogBundle(validBundle);
  const anthropic = parsed.providers.anthropic;
  expect(anthropic).not.toHaveProperty("baseUrl");
  expect(anthropic).not.toHaveProperty("headers");
  expect(anthropic).toMatchObject({
    defaultModel: "claude-test",
    defaultUtilityModel: "claude-test",
  });
  expect(anthropic?.models[0]).not.toHaveProperty("baseUrl");
  expect(anthropic?.models[0]).not.toHaveProperty("headers");
  expect(anthropic?.models[0]).toMatchObject({
    contextWindows,
    contextWindowDefault: "1m",
    compat: { nested: {} },
  });
  expect(anthropic?.models[0]?.compat).toEqual({ nested: {} });
  expect(parsed.pricing?.["openai/gpt-external"]).toEqual({
    input: 2.5,
    output: 10,
    cacheRead: 1.25,
  });
});

it("preserves ordered v2 recommendations and provider-scoped model identities and prices", () => {
  const bundle = parseRemoteModelCatalogBundleV2({
    ...validBundleV2,
    providers: {
      first: { ...validBundleV2.providers.first, recommendedModels: [" other ", "vendor/model"] },
      second: validBundleV2.providers.second,
    },
    models: [
      ...validBundleV2.models,
      { id: "other", provider: "first", pricing: { status: "unknown" } },
    ],
  });
  expect(bundle.providers).toEqual({
    ...validBundleV2.providers,
    first: { ...validBundleV2.providers.first, recommendedModels: ["other", "vendor/model"] },
  });
  expect(bundle.models.slice(0, 2)).toEqual(validBundleV2.models);
});

it("preserves partial rates, context tiers, and authoritative unavailable prices", () => {
  const tiers = [
    { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0, range: [0, 200_000] },
    { input: 4, output: 12, cacheRead: 1, cacheWrite: 0, range: [200_000] },
  ];
  const pricing = [
    { ...knownPrice, input: 2 },
    { ...knownPrice, tieredPricing: tiers },
    { status: "unavailable", source: "native-feed" },
  ];
  const bundle = parseRemoteModelCatalogBundleV2({
    ...validBundleV2,
    models: pricing.map((price, index) => ({
      id: `model-${index}`,
      provider: "first",
      pricing: price,
    })),
  });
  expect(bundle.models.map((model) => model.pricing)).toEqual(pricing);
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
  const bundle = validateAndSanitizeRemoteModelCatalogBundleV2({
    ...validBundleV2,
    providers: { headers: {}, baseUrl: {} },
    models,
  });
  expect(Object.keys(bundle.providers)).toEqual(["headers", "baseUrl"]);
  expect(bundle.models.map((model) => model.provider)).toEqual(["headers", "baseUrl"]);
  expect(bundle.models[0]).toMatchObject({
    contextWindows,
    contextWindowDefault: "1m",
    compat: { supportsTools: true, nested: {} },
  });
  expect(bundle.models[0]?.compat).toEqual({ supportsTools: true, nested: {} });
  expect(() => parseRemoteModelCatalogBundleV2(bundle)).not.toThrow();
});
