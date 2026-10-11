import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyConfiguredContextWindows,
  prepareDiscoveredContextTokenCache,
  type ContextWindowCatalog,
} from "./context-cache-projection.js";
import {
  getContextWindowCaches,
  providerContextTokenCacheKey,
  replaceDiscoveredContextTokenCache,
} from "./context-cache.js";
import { resolveContextTokensForModel, resolveModelContextTokenProjection } from "./context.js";
import { resetContextWindowCacheForTest } from "./context.test-support.js";

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  projectConfigOntoRuntimeSourceSnapshot: (config: unknown) => config,
}));

function modelConfig(
  provider: string,
  id: string,
  limits: Partial<Pick<ModelDefinitionConfig, "contextWindow" | "contextTokens">>,
): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://example.invalid",
          models: [
            {
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 4096,
              ...limits,
            },
          ],
        },
      },
    },
  };
}

function resolve(params: Parameters<typeof resolveContextTokensForModel>[0]) {
  return resolveContextTokensForModel({ allowAsyncLoad: false, ...params });
}

async function discover(models: ContextWindowCatalog["entries"]) {
  replaceDiscoveredContextTokenCache(
    await prepareDiscoveredContextTokenCache({ modelCatalog: { entries: models } }),
  );
}

beforeEach(resetContextWindowCacheForTest);
afterEach(resetContextWindowCacheForTest);

describe("context cache projection", () => {
  it("keeps unowned CLI discovery at its reported window", async () => {
    await discover([{ id: "claude-cli/claude-opus-4.7-20260219", contextWindow: 200_000 }]);
    expect(resolve({ model: "claude-cli/claude-opus-4.7-20260219" })).toBe(200_000);
  });

  it("adds valid configured windows and ignores invalid entries", () => {
    const cache = new Map<string, number>();
    const windowCache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      windowCache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [
              { id: "custom/model", contextWindow: 150_000 },
              { id: "bad/model", contextWindow: 0 },
              { id: "", contextWindow: 300_000 },
            ],
          },
        },
      },
    });
    expect(windowCache.get("custom/model")).toBe(150_000);
    expect(windowCache.has("bad/model")).toBe(false);
    expect(windowCache.has("")).toBe(false);
  });
});

describe("context token resolution", () => {
  it.each(["configuredTokenCache", "discoveredTokenCache", "contextWindowCache"] as const)(
    "keeps captured reporting independent of a stale %s without changing execution lookup",
    (cacheName) => {
      const caches = getContextWindowCaches();
      const key = providerContextTokenCacheKey("custom", "large");
      caches[cacheName].set(key, 128_000);
      const selected = {
        cfg: {},
        provider: "custom",
        model: "large",
        modelContextTokens: 922_000,
        modelContextWindow: 1_050_000,
      };
      expect(resolve(selected)).toBe(128_000);
      expect(resolve({ ...selected, allowCacheLookup: false })).toBe(922_000);
      expect(caches[cacheName].get(key)).toBe(128_000);
    },
  );

  it("preserves genuine selected limits and authored caps without cache lookup", () => {
    const selected = {
      cfg: {},
      provider: "custom",
      model: "large",
      allowCacheLookup: false,
    };
    expect(resolve({ ...selected, modelContextTokens: 128_000, modelContextWindow: 128_000 })).toBe(
      128_000,
    );
    expect(
      resolve({
        ...selected,
        cfg: modelConfig("custom", "large", {
          contextTokens: 64_000,
          contextWindow: 1_050_000,
        }),
        modelContextTokens: 922_000,
        modelContextWindow: 1_050_000,
      }),
    ).toBe(64_000);
    expect(
      resolve({
        ...selected,
        cfg: modelConfig("custom", "large", {
          contextTokens: 922_000,
          contextWindow: 64_000,
        }),
        modelContextTokens: 922_000,
        modelContextWindow: 1_050_000,
      }),
    ).toBe(64_000);
  });

  it("does not replace unknown captured capacity with a sibling's bare cache", async () => {
    await discover([{ provider: "other", id: "shared-model", contextTokens: 128_000 }]);
    const selected = { cfg: {}, provider: "custom", model: "shared-model" };
    expect(resolve(selected)).toBe(128_000);
    expect(resolve({ ...selected, allowCacheLookup: false })).toBeUndefined();
    expect(resolve({ ...selected, allowCacheLookup: false, fallbackContextTokens: 32_000 })).toBe(
      32_000,
    );
  });

  it("preserves fixed provider contracts without process cache lookup", () => {
    expect(
      resolve({ provider: "anthropic", model: "claude-sonnet-5", allowCacheLookup: false }),
    ).toBe(1_000_000);
  });

  it("can exclude unscoped discovery from provider-owned lookup", async () => {
    await discover([{ id: "large", contextTokens: 32_000 }]);
    const params = { provider: "claude-cli", model: "large" };
    expect(resolve({ ...params, allowUnscopedModelLookup: false })).toBeUndefined();
    expect(resolve(params)).toBe(32_000);
  });

  it("lets a model disable the global context1m setting", () => {
    expect(
      resolve({
        cfg: {
          agents: {
            defaults: {
              params: { context1m: true },
              models: { "claude-cli/claude-opus-4-7": { params: { context1m: false } } },
            },
          },
        },
        provider: "claude-cli",
        model: "claude-opus-4-7",
        fallbackContextTokens: 200_000,
      }),
    ).toBe(200_000);
  });

  it.each([
    ["claude-cli", "claude-sonnet-5"],
    ["anthropic-vertex", "claude-sonnet-4-6"],
  ])("resolves the fixed window for %s/%s", (provider, model) => {
    expect(resolve({ provider, model, fallbackContextTokens: 200_000 })).toBe(1_000_000);
  });

  it("retains authored cap provenance when a native window lowers the effective cap", () => {
    const params = {
      cfg: modelConfig("custom", "wide", { contextWindow: 128_000, contextTokens: 1_000_000 }),
      provider: "custom",
      model: "wide",
      allowAsyncLoad: false,
    };
    expect(resolveModelContextTokenProjection(params)).toEqual({
      contextTokens: 128_000,
      authoredContextTokens: 1_000_000,
      configuredContextTokenLimits: {
        configuredContextTokens: 1_000_000,
        effectiveConfiguredTokens: 128_000,
        authoredContextTokenCap: 128_000,
        configuredContextWindow: 128_000,
        fixedContextWindow: undefined,
      },
      source: "configured",
    });
    expect(resolve(params)).toBe(128_000);
  });

  it("uses the caller-supplied model provider for runtime aliases", () => {
    expect(
      resolve({
        cfg: modelConfig("anthropic", "claude-custom", {
          contextWindow: 180_000,
          contextTokens: 100_000,
        }),
        provider: "fixture-cli",
        modelProvider: "anthropic",
        model: "anthropic/claude-custom",
      }),
    ).toBe(100_000);
  });

  it("keeps configured token caps authoritative over lower discovery", async () => {
    await discover([{ provider: "openai", id: "gpt-5.5", contextWindow: 272_000 }]);
    const cfg = modelConfig("openai", "gpt-5.5", { contextTokens: 350_000 });
    const caches = getContextWindowCaches();
    applyConfiguredContextWindows({
      cache: caches.configuredTokenCache,
      windowCache: caches.contextWindowCache,
      modelsConfig: cfg.models,
    });
    expect(resolve({ provider: "openai", model: "gpt-5.5" })).toBe(350_000);
  });

  it("keeps provider discovery ahead of static caps under configured windows", async () => {
    await discover([{ provider: "openai", id: "gpt-5.5", contextTokens: 200_000 }]);
    expect(
      resolve({
        cfg: modelConfig("openai", "gpt-5.5", { contextWindow: 1_000_000 }),
        provider: "openai",
        model: "gpt-5.5",
        modelContextTokens: 272_000,
      }),
    ).toBe(200_000);
  });
});

describe("estimated catalog capacity", () => {
  it.each([
    [undefined, undefined],
    [777_000, 777_000],
  ])(
    "does not publish a synthetic native window as discovered capacity with prompt cap %s",
    async (contextTokens, expected) => {
      await discover([
        {
          provider: "fixture-provider",
          id: "estimated",
          contextWindow: 128_000,
          contextWindowSource: "synthetic",
          contextTokens,
        },
      ]);
      expect(
        resolve({
          provider: "fixture-provider",
          model: "estimated",
          allowUnscopedModelLookup: false,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ["synthetic" as const, 777_000],
    [undefined, 128_000],
  ] as const)(
    "keeps reported prompt capacity while honoring genuine native capacity (%s)",
    (modelContextWindowSource, expected) => {
      expect(
        resolveModelContextTokenProjection({
          cfg: {},
          provider: "fixture-provider",
          model: "estimated",
          modelContextWindow: 128_000,
          modelContextWindowSource,
          modelContextTokens: 777_000,
          allowAsyncLoad: false,
          allowUnscopedModelLookup: false,
        }).contextTokens,
      ).toBe(expected);
    },
  );
});

describe("native owner isolation", () => {
  it("does not borrow an API cache capacity for a native harness", () => {
    replaceDiscoveredContextTokenCache(
      new Map([[providerContextTokenCacheKey("openai", "gpt-4o"), 128_000]]),
    );
    expect(
      resolveModelContextTokenProjection({
        cfg: {},
        provider: "openai",
        model: "gpt-4o",
        nativeRuntime: "codex",
        allowAsyncLoad: false,
        allowUnscopedModelLookup: false,
      }),
    ).toEqual({
      contextTokens: undefined,
      authoredContextTokens: undefined,
      configuredContextTokenLimits: {
        configuredContextTokens: undefined,
        effectiveConfiguredTokens: undefined,
        authoredContextTokenCap: undefined,
        configuredContextWindow: undefined,
        fixedContextWindow: undefined,
      },
      source: "fallback",
    });
  });
});

it("keeps native rows out of the shared API capacity projection", async () => {
  await discover([
    { provider: "fixture-provider", id: "same", contextWindow: 400_000 },
    { provider: "fixture-provider", id: "same", contextWindow: 64_000, nativeRuntime: "codex" },
  ]);
  expect(
    resolve({ provider: "fixture-provider", model: "same", allowUnscopedModelLookup: false }),
  ).toBe(400_000);
});
