import { describe, expect, it } from "vitest";
import {
  parseRemoteModelCatalogBundle,
  parseRemoteModelCatalogBundleV2,
  validateAndSanitizeRemoteModelCatalogBundle,
  validateAndSanitizeRemoteModelCatalogBundleV2,
} from "./remote-catalog-bundle.js";

const validBundle = {
  schemaVersion: 1,
  generatedAt: 1_753_500_000_000,
  minVersion: "2026.7.0",
  sourceCommit: "abc123",
  providers: {
    anthropic: {
      baseUrl: "https://evil.test",
      headers: { Authorization: "bad" },
      defaultModel: "claude-test",
      defaultUtilityModel: "claude-test",
      models: [
        {
          id: "claude-test",
          baseUrl: "https://evil.test/model",
          headers: { "X-Evil": "yes" },
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
          compat: { nested: { baseUrl: "https://evil.test/nested", headers: { X: "y" } } },
        },
      ],
    },
  },
  pricing: {
    "openai/gpt-external": { input: 2.5, output: 10, cacheRead: 1.25 },
  },
} as const;

describe("remote model catalog bundle", () => {
  it("accepts schema v1 and deeply strips endpoint and header fields", () => {
    const parsed = validateAndSanitizeRemoteModelCatalogBundle(validBundle);
    const anthropic = parsed.providers.anthropic;
    if (!anthropic) {
      throw new Error("expected anthropic provider");
    }
    expect(anthropic).not.toHaveProperty("baseUrl");
    expect(anthropic).not.toHaveProperty("headers");
    expect(anthropic).toMatchObject({
      defaultModel: "claude-test",
      defaultUtilityModel: "claude-test",
    });
    expect(anthropic.models[0]).not.toHaveProperty("baseUrl");
    expect(anthropic.models[0]).not.toHaveProperty("headers");
    expect(anthropic.models[0]?.compat).toEqual({ nested: {} });
    expect(anthropic.models[0]).toMatchObject({
      contextWindows: [
        { id: "200k", label: "200K", contextWindow: 200_000 },
        { id: "1m", label: "1M", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "1m",
    });
    expect(parsed.pricing?.["openai/gpt-external"]).toEqual({
      input: 2.5,
      output: 10,
      cacheRead: 1.25,
    });
  });

  it("rejects unsupported versions, invalid timestamps, and malformed providers", () => {
    expect(() => parseRemoteModelCatalogBundle({ ...validBundle, schemaVersion: 2 })).toThrow();
    expect(() => parseRemoteModelCatalogBundle({ ...validBundle, generatedAt: 0 })).toThrow();
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        generatedAt: Date.now() + 2 * 24 * 60 * 60_000,
      }),
    ).toThrow("generatedAt is implausibly far in the future");
    expect(() =>
      parseRemoteModelCatalogBundle({ ...validBundle, providers: { anthropic: { models: [] } } }),
    ).toThrow();
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        providers: { anthropic: { models: [{ id: " duplicate " }, { id: "duplicate" }] } },
      }),
    ).toThrow("duplicate model id: duplicate");
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        pricing: { "openai/bad": { input: -1, output: 2 } },
      }),
    ).toThrow();
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        pricing: { "openai/bad": { input: 1, output: 2, baseUrl: "https://bad.test" } },
      }),
    ).toThrow();
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        providers: {
          anthropic: {
            models: [
              {
                id: "bad-default",
                contextWindows: [{ id: "200k", label: "200K", contextWindow: 200_000 }],
                contextWindowDefault: "1m",
              },
            ],
          },
        },
      }),
    ).toThrow("contextWindowDefault must reference a declared contextWindows option");
  });
});

const validBundleV2 = {
  schemaVersion: 2,
  generatedAt: 1_753_500_000_000,
  sourceCommit: "abc123",
  providers: {
    first: { defaultModel: "vendor/model" },
    second: { defaultUtilityModel: "vendor/model" },
  },
  models: [
    {
      id: "vendor/model",
      provider: "first",
      input: ["text"],
      pricing: {
        status: "known",
        currency: "USD",
        unit: "million_tokens",
        source: "native-feed",
        input: 0,
        output: 0,
      },
    },
    { id: "vendor/model", provider: "second", pricing: { status: "unknown" } },
  ],
} as const;

describe("remote model catalog v2", () => {
  it("preserves ordered provider recommendations only in v2", () => {
    const providers = { first: { recommendedModels: [" other ", "vendor/model"] }, second: {} };
    const bundle = parseRemoteModelCatalogBundleV2({
      ...validBundleV2,
      providers,
      models: [
        ...validBundleV2.models,
        { id: "other", provider: "first", pricing: { status: "unknown" } },
      ],
    });
    expect(bundle.providers.first?.recommendedModels).toEqual(["other", "vendor/model"]);
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        providers: {
          anthropic: { ...validBundle.providers.anthropic, recommendedModels: ["claude-test"] },
        },
      }),
    ).toThrow("recommendedModels");
  });

  it.each([
    ["unknown id", ["missing"]],
    ["duplicate id", ["vendor/model", " vendor/model "]],
    ["over cap", Array.from({ length: 9 }, (_, index) => `model-${index}`)],
    ["empty id", [" "]],
    ["other provider", ["second-only"]],
  ])("rejects recommended models with %s", (_name, recommendedModels) => {
    expect(() =>
      parseRemoteModelCatalogBundleV2({
        ...validBundleV2,
        providers: { first: { recommendedModels }, second: {} },
        models: [
          ...validBundleV2.models,
          ...Array.from({ length: 9 }, (_, index) => ({
            id: `model-${index}`,
            provider: "first",
            pricing: { status: "unknown" },
          })),
          { id: "second-only", provider: "second", pricing: { status: "unknown" } },
        ],
      }),
    ).toThrow();
  });

  it("keeps native ids distinct by provider and unknown prices distinct from free", () => {
    const bundle = parseRemoteModelCatalogBundleV2(validBundleV2);
    expect(bundle.providers).toEqual(validBundleV2.providers);
    expect(bundle.models.map(({ id, provider, pricing }) => ({ id, provider, pricing }))).toEqual([
      {
        id: "vendor/model",
        provider: "first",
        pricing: {
          status: "known",
          currency: "USD",
          unit: "million_tokens",
          source: "native-feed",
          input: 0,
          output: 0,
        },
      },
      { id: "vendor/model", provider: "second", pricing: { status: "unknown" } },
    ]);
  });

  it("preserves partial rates, context tiers, and authoritative unavailable prices", () => {
    const tiers = [
      { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0, range: [0, 200_000] },
      { input: 4, output: 12, cacheRead: 1, cacheWrite: 0, range: [200_000] },
    ];
    const bundle = parseRemoteModelCatalogBundleV2({
      ...validBundleV2,
      models: [
        {
          id: "partial",
          provider: "first",
          pricing: { status: "known", currency: "USD", unit: "million_tokens", input: 2 },
        },
        {
          id: "tiered",
          provider: "first",
          pricing: {
            status: "known",
            currency: "USD",
            unit: "million_tokens",
            tieredPricing: tiers,
          },
        },
        {
          id: "unpriced",
          provider: "first",
          pricing: { status: "unavailable", source: "native-feed" },
        },
      ],
    });
    expect(bundle.models[0]?.pricing).toEqual({
      status: "known",
      currency: "USD",
      unit: "million_tokens",
      input: 2,
    });
    expect(bundle.models[1]?.pricing).toMatchObject({ tieredPricing: tiers });
    expect(bundle.models[2]?.pricing).toEqual({ status: "unavailable", source: "native-feed" });
  });

  it("retains model metadata while stripping nested transport overrides", () => {
    const bundle = validateAndSanitizeRemoteModelCatalogBundleV2({
      ...validBundleV2,
      models: [
        {
          ...validBundleV2.models[0],
          contextWindows: [{ id: "large", label: "Large", contextWindow: 200_000 }],
          contextWindowDefault: "large",
          compat: {
            supportsTools: true,
            nested: { baseUrl: "https://bad.test", headers: { X: "bad" } },
          },
        },
      ],
    });
    expect(bundle.models[0]).toMatchObject({
      contextWindowDefault: "large",
      contextWindows: [{ id: "large", label: "Large", contextWindow: 200_000 }],
      compat: { supportsTools: true, nested: {} },
    });
  });

  it("preserves provider identities that resemble transport fields", () => {
    const bundle = validateAndSanitizeRemoteModelCatalogBundleV2({
      ...validBundleV2,
      providers: { headers: {}, baseUrl: {} },
      models: [
        { ...validBundleV2.models[0], provider: "headers" },
        { ...validBundleV2.models[1], provider: "baseUrl" },
      ],
    });
    expect(Object.keys(bundle.providers)).toEqual(["headers", "baseUrl"]);
    expect(bundle.models.map((model) => model.provider)).toEqual(["headers", "baseUrl"]);
    expect(() => parseRemoteModelCatalogBundleV2(bundle)).not.toThrow();
  });

  it.each([
    {
      name: "duplicate tuple",
      models: [validBundleV2.models[0], { ...validBundleV2.models[0], id: " vendor/model " }],
      error: "duplicate provider/model",
    },
    {
      name: "undeclared provider",
      models: [{ ...validBundleV2.models[0], provider: "missing" }],
      error: "undeclared model provider",
    },
    {
      name: "transport override",
      models: [{ ...validBundleV2.models[0], baseUrl: "https://bad.test" }],
      error: "baseUrl",
    },
    {
      name: "invalid context choice",
      models: [{ ...validBundleV2.models[0], contextWindowDefault: "missing" }],
      error: "contextWindowDefault",
    },
    {
      name: "unknown price with rates",
      models: [{ ...validBundleV2.models[0], pricing: { status: "unknown", input: 0 } }],
      error: "input",
    },
    {
      name: "empty known price",
      models: [
        {
          ...validBundleV2.models[0],
          pricing: { status: "known", currency: "USD", unit: "million_tokens" },
        },
      ],
      error: "known pricing must contain rates",
    },
    {
      name: "negative rate",
      models: [
        { ...validBundleV2.models[0], pricing: { ...validBundleV2.models[0].pricing, input: -1 } },
      ],
      error: "input",
    },
  ])("rejects $name", ({ models, error }) => {
    expect(() => parseRemoteModelCatalogBundleV2({ ...validBundleV2, models })).toThrow(error);
  });

  it("keeps each version strict and rejects a detached pricing map in v2", () => {
    expect(() => parseRemoteModelCatalogBundle(validBundleV2)).toThrow();
    expect(() => parseRemoteModelCatalogBundleV2(validBundle)).toThrow();
    expect(() => parseRemoteModelCatalogBundleV2({ ...validBundleV2, schemaVersion: 3 })).toThrow();
    expect(() => parseRemoteModelCatalogBundleV2({ ...validBundleV2, pricing: {} })).toThrow();
  });

  it.each([
    { name: "unsourced rate", upstreamPricing: { "vendor/model": { input: 1, output: 2 } } },
    { name: "bare model key", upstreamPricing: { model: { input: 1, output: 2, source: "x" } } },
  ])("rejects standalone pricing with $name", ({ upstreamPricing }) => {
    expect(() => parseRemoteModelCatalogBundleV2({ ...validBundleV2, upstreamPricing })).toThrow();
    expect(() =>
      parseRemoteModelCatalogBundleV2({ ...validBundleV2, providerPricing: upstreamPricing }),
    ).toThrow();
  });
});
