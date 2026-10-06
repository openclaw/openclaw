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
  it("prefers discovered contextTokens over the native window", async () => {
    await discover([{ id: "gpt-5.4", contextWindow: 1_050_000, contextTokens: 272_000 }]);
    expect(resolve({ model: "gpt-5.4" })).toBe(272_000);
  });

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

  it("writes provider-owned bare keys for self-prefixed configured token caps", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      windowCache: new Map(),
      modelsConfig: {
        providers: {
          "google-gemini-cli": {
            models: [
              {
                id: "google-gemini-cli/gemini-3.1-pro-preview",
                contextTokens: 1_000_000,
              },
            ],
          },
        },
      },
    });
    expect(
      cache.get(providerContextTokenCacheKey("google-gemini-cli", "gemini-3.1-pro-preview")),
    ).toBe(1_000_000);
  });
});

describe("context token resolution", () => {
  it("can exclude unscoped discovery from provider-owned lookup", async () => {
    await discover([{ id: "large", contextTokens: 32_000 }]);
    const params = { provider: "claude-cli", model: "large" };
    expect(resolve({ ...params, allowUnscopedModelLookup: false })).toBeUndefined();
    expect(resolve(params)).toBe(32_000);
  });

  it.each([
    [true, 1_000_000],
    [false, 200_000],
  ])("uses the model context1m setting %s over the global default", (context1m, expected) => {
    expect(
      resolve({
        cfg: {
          agents: {
            defaults: {
              params: { context1m: !context1m },
              models: { "claude-cli/claude-opus-4-7": { params: { context1m } } },
            },
          },
        },
        provider: "claude-cli",
        model: "claude-opus-4-7",
        fallbackContextTokens: 200_000,
      }),
    ).toBe(expected);
  });

  it.each([
    ["anthropic", "claude-fable-5"],
    ["anthropic-vertex", "claude-mythos-5"],
    ["claude-cli", "claude-sonnet-5"],
    ["claude-cli", "claude-opus-5"],
    ["anthropic-vertex", "claude-sonnet-4-6"],
    ["claude-cli", "claude-opus-4-7[1m]"],
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
    });
    expect(resolve(params)).toBe(128_000);
  });

  it.each([
    [200_000, 200_000],
    [1_200_000, 1_000_000],
  ])("bounds an authored cap of %i by the fixed provider contract", (contextTokens, expected) => {
    expect(
      resolve({
        cfg: modelConfig("anthropic", "claude-sonnet-4-6", {
          contextWindow: 2_000_000,
          contextTokens,
        }),
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    ).toBe(expected);
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

  it.each([
    [1_000_000, 272_000],
    [128_000, 128_000],
  ])("bounds prepared tokens by a configured native window of %i", (contextWindow, expected) => {
    const caches = getContextWindowCaches();
    applyConfiguredContextWindows({
      cache: caches.discoveredTokenCache,
      windowCache: caches.contextWindowCache,
      modelsConfig: modelConfig("openai", "gpt-5.5", { contextWindow }).models,
    });
    expect(
      resolve({
        provider: "openai",
        model: "gpt-5.5",
        modelContextTokens: 272_000,
      }),
    ).toBe(expected);
  });
});
