import { beforeEach, describe, expect, it, vi } from "vitest";

type DiscoveredModel = { id: string; provider?: string; contextWindow: number };

function mockContextDeps(params: {
  loadConfig: () => unknown;
  discoveredModels?: DiscoveredModel[];
}) {
  const ensureOpenClawModelsJson = vi.fn(async () => {});
  vi.doMock("../config/config.js", () => ({
    loadConfig: params.loadConfig,
  }));
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson,
  }));
  vi.doMock("./agent-paths.js", () => ({
    resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
  }));
  vi.doMock("./pi-model-discovery-runtime.js", () => ({
    discoverAuthStorage: vi.fn(() => ({})),
    discoverModels: vi.fn(() => ({
      getAll: () => params.discoveredModels ?? [],
    })),
  }));
  return { ensureOpenClawModelsJson };
}

function mockContextModuleDeps(loadConfigImpl: () => unknown) {
  return mockContextDeps({ loadConfig: loadConfigImpl });
}

// Shared mock setup used by multiple tests.
function mockDiscoveryDeps(
  models: DiscoveredModel[],
  configModels?: Record<string, { models: Array<{ id: string; contextWindow: number }> }>,
) {
  mockContextDeps({
    loadConfig: () => ({ models: configModels ? { providers: configModels } : {} }),
    discoveredModels: models,
  });
}

function createContextOverrideConfig(provider: string, model: string, contextWindow: number) {
  return {
    models: {
      providers: {
        [provider]: {
          models: [{ id: model, contextWindow }],
        },
      },
    },
  };
}

async function flushAsyncWarmup() {
  await new Promise((r) => setTimeout(r, 0));
}

async function importResolveContextTokensForModel() {
  const { resolveContextTokensForModel } = await import("./context.js");
  await flushAsyncWarmup();
  return resolveContextTokensForModel;
}

describe("lookupContextTokens", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns configured model context window on first lookup", async () => {
    mockContextModuleDeps(() => ({
      models: {
        providers: {
          openrouter: {
            models: [{ id: "openrouter/claude-sonnet", contextWindow: 321_000 }],
          },
        },
      },
    }));

    const { lookupContextTokens } = await import("./context.js");
    expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(321_000);
  });

  it("can skip async warmup for read-only callers", async () => {
    const { ensureOpenClawModelsJson } = mockContextModuleDeps(() => ({
      models: {
        providers: {
          openrouter: {
            models: [{ id: "openrouter/claude-sonnet", contextWindow: 321_000 }],
          },
        },
      },
    }));

    const { lookupContextTokens } = await import("./context.js");
    expect(
      lookupContextTokens("openrouter/claude-sonnet", { allowAsyncLoad: false }),
    ).toBeUndefined();
    await flushAsyncWarmup();
    expect(ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("prefers provider-qualified discovered context windows when provider is known", async () => {
    mockDiscoveryDeps([
      { provider: "anthropic", id: "claude-sonnet", contextWindow: 1_000_000 },
      { provider: "openrouter", id: "claude-sonnet", contextWindow: 200_000 },
    ]);

    const { lookupContextTokens, resolveContextTokensForModel } = await import("./context.js");
    lookupContextTokens("anthropic/claude-sonnet");
    await flushAsyncWarmup();

    expect(lookupContextTokens("anthropic/claude-sonnet")).toBe(1_000_000);
    expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(200_000);
    expect(
      resolveContextTokensForModel({
        provider: "anthropic",
        model: "claude-sonnet",
        fallbackContextTokens: 128_000,
      }),
    ).toBe(1_000_000);
    expect(
      resolveContextTokensForModel({
        provider: "openrouter",
        model: "claude-sonnet",
        fallbackContextTokens: 128_000,
      }),
    ).toBe(200_000);
  });

  it("prefers configured bare-id overrides over discovered provider-qualified windows", async () => {
    mockDiscoveryDeps([{ provider: "customprovider", id: "llama-3.1-8b", contextWindow: 8_192 }], {
      customprovider: {
        models: [{ id: "llama-3.1-8b", contextWindow: 131_072 }],
      },
    });

    const resolveContextTokensForModel = await importResolveContextTokensForModel();
    expect(
      resolveContextTokensForModel({
        provider: "customprovider",
        model: "llama-3.1-8b",
        fallbackContextTokens: 4_096,
      }),
    ).toBe(131_072);
  });

  it("only warms eagerly for real openclaw startup commands that need model metadata", async () => {
    const argvSnapshot = process.argv;
    try {
      for (const scenario of [
        {
          argv: ["node", "openclaw", "chat"],
          expectedCalls: 1,
        },
        {
          argv: ["node", "openclaw", "--profile", "--", "config", "validate"],
          expectedCalls: 0,
        },
        {
          argv: ["node", "openclaw", "logs", "--limit", "5"],
          expectedCalls: 0,
        },
        {
          argv: ["node", "openclaw", "status", "--json"],
          expectedCalls: 0,
        },
        {
          argv: ["node", "scripts/test-built-plugin-singleton.mjs"],
          expectedCalls: 0,
        },
      ]) {
        vi.resetModules();
        const loadConfigMock = vi.fn(() => ({ models: {} }));
        const { ensureOpenClawModelsJson } = mockContextModuleDeps(loadConfigMock);
        process.argv = scenario.argv;
        await import("./context.js");
        await flushAsyncWarmup();
        expect(loadConfigMock).toHaveBeenCalledTimes(scenario.expectedCalls);
        expect(ensureOpenClawModelsJson).toHaveBeenCalledTimes(scenario.expectedCalls);
      }
    } finally {
      process.argv = argvSnapshot;
    }
  });

  it("retries config loading after backoff when an initial load fails", async () => {
    vi.useFakeTimers();
    const loadConfigMock = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("transient");
      })
      .mockImplementation(() => ({
        models: {
          providers: {
            openrouter: {
              models: [{ id: "openrouter/claude-sonnet", contextWindow: 654_321 }],
            },
          },
        },
      }));

    mockContextModuleDeps(loadConfigMock);

    try {
      const { lookupContextTokens } = await import("./context.js");
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(654_321);
      expect(loadConfigMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the smaller window when the same bare model id is discovered under multiple providers", async () => {
    mockDiscoveryDeps([
      { id: "gemini-3.1-pro-preview", contextWindow: 1_048_576 },
      { id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
    ]);

    const { lookupContextTokens } = await import("./context.js");
    lookupContextTokens("gemini-3.1-pro-preview");
    await flushAsyncWarmup();
    // Conservative minimum: bare-id cache feeds runtime flush/compaction paths.
    expect(lookupContextTokens("gemini-3.1-pro-preview")).toBe(128_000);
  });

  it("resolveContextTokensForModel returns discovery value when provider-qualified entry exists in cache", async () => {
    // Registry returns provider-qualified entries (real-world scenario from #35976).
    // When no explicit config override exists, the bare cache lookup hits the
    // provider-qualified raw discovery entry.
    mockDiscoveryDeps([
      { id: "github-copilot/gemini-3.1-pro-preview", contextWindow: 128_000 },
      { id: "google-gemini-cli/gemini-3.1-pro-preview", contextWindow: 1_048_576 },
    ]);

    const { lookupContextTokens, resolveContextTokensForModel } = await import("./context.js");
    lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview");
    await flushAsyncWarmup();

    // With provider specified and no config override, bare lookup finds the
    // provider-qualified discovery entry.
    const result = resolveContextTokensForModel({
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(1_048_576);
  });

  it("resolveContextTokensForModel returns configured override via direct config scan (beats discovery)", async () => {
    // Config has an explicit contextWindow; resolveContextTokensForModel should
    // return it via direct config scan, preventing collisions with raw discovery
    // entries. Real callers (status.summary.ts etc.) always pass cfg.
    mockDiscoveryDeps([
      { id: "google-gemini-cli/gemini-3.1-pro-preview", contextWindow: 1_048_576 },
    ]);

    const cfg = createContextOverrideConfig("google-gemini-cli", "gemini-3.1-pro-preview", 200_000);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    const result = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(200_000);
  });

  it("resolveContextTokensForModel honors configured overrides when provider keys use mixed case", async () => {
    mockDiscoveryDeps([{ id: "openrouter/anthropic/claude-sonnet-4-5", contextWindow: 1_048_576 }]);

    const cfg = createContextOverrideConfig(" OpenRouter ", "anthropic/claude-sonnet-4-5", 200_000);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    const result = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(result).toBe(200_000);
  });

  it("resolveContextTokensForModel: config direct scan prevents OpenRouter qualified key collision for Google provider", async () => {
    // When provider is explicitly "google" and cfg has a Google contextWindow
    // override, the config direct scan returns it before any cache lookup —
    // so the OpenRouter raw "google/gemini-2.5-pro" qualified entry is never hit.
    // Real callers (status.summary.ts) always pass cfg when provider is explicit.
    mockDiscoveryDeps([{ id: "google/gemini-2.5-pro", contextWindow: 999_000 }]);

    const cfg = createContextOverrideConfig("google", "gemini-2.5-pro", 2_000_000);
    const { lookupContextTokens, resolveContextTokensForModel } = await import("./context.js");
    lookupContextTokens("google/gemini-2.5-pro");
    await flushAsyncWarmup();

    // Google with explicit cfg: config direct scan wins before any cache lookup.
    const googleResult = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "google",
      model: "gemini-2.5-pro",
    });
    expect(googleResult).toBe(2_000_000);

    // OpenRouter provider with slash model id: bare lookup finds the raw entry.
    const openrouterResult = resolveContextTokensForModel({
      provider: "openrouter",
      model: "google/gemini-2.5-pro",
    });
    expect(openrouterResult).toBe(999_000);
  });

  it("resolveContextTokensForModel prefers exact provider key over alias-normalized match", async () => {
    // When both "qwen" and "qwen-portal" exist as config keys (alias pattern),
    // resolveConfiguredProviderContextWindow must return the exact-key match first,
    // not the first normalized hit — mirroring pi-embedded-runner/model.ts behaviour.
    mockDiscoveryDeps([]);

    const cfg = {
      models: {
        providers: {
          "qwen-portal": { models: [{ id: "qwen-max", contextWindow: 32_000 }] },
          qwen: { models: [{ id: "qwen-max", contextWindow: 128_000 }] },
        },
      },
    };

    const { resolveContextTokensForModel } = await import("./context.js");
    await flushAsyncWarmup();

    // Exact key "qwen" wins over the alias-normalized match "qwen-portal".
    const qwenResult = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "qwen",
      model: "qwen-max",
    });
    expect(qwenResult).toBe(128_000);

    // Exact key "qwen-portal" wins (no alias lookup needed).
    const portalResult = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "qwen-portal",
      model: "qwen-max",
    });
    expect(portalResult).toBe(32_000);
  });

  it("resolveContextTokensForModel(model-only) does not apply config scan for inferred provider", async () => {
    // status.ts log-usage fallback calls resolveContextTokensForModel({ model })
    // with no provider. When model = "google/gemini-2.5-pro" (OpenRouter ID),
    // resolveProviderModelRef infers provider="google". Without the guard,
    // resolveConfiguredProviderContextWindow would return Google's configured
    // window and misreport context limits for the OpenRouter session.
    mockDiscoveryDeps([{ id: "google/gemini-2.5-pro", contextWindow: 999_000 }]);

    const cfg = createContextOverrideConfig("google", "gemini-2.5-pro", 2_000_000);
    const { lookupContextTokens, resolveContextTokensForModel } = await import("./context.js");
    lookupContextTokens("google/gemini-2.5-pro");
    await flushAsyncWarmup();

    // model-only call (no explicit provider) must NOT apply config direct scan.
    // Falls through to bare cache lookup: "google/gemini-2.5-pro" → 999k ✓.
    const modelOnlyResult = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "google/gemini-2.5-pro",
      // no provider
    });
    expect(modelOnlyResult).toBe(999_000);

    // Explicit provider still uses config scan ✓.
    const explicitResult = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "google",
      model: "gemini-2.5-pro",
    });
    expect(explicitResult).toBe(2_000_000);
  });

  it("resolveContextTokensForModel: qualified key beats bare min when provider is explicit (original #35976 fix)", async () => {
    // Regression: when both "gemini-3.1-pro-preview" (bare, min=128k) AND
    // "google-gemini-cli/gemini-3.1-pro-preview" (qualified, 1M) are in cache,
    // an explicit-provider call must return the provider-specific qualified value,
    // not the collided bare minimum.
    mockDiscoveryDeps([
      { id: "github-copilot/gemini-3.1-pro-preview", contextWindow: 128_000 },
      { id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
      { id: "google-gemini-cli/gemini-3.1-pro-preview", contextWindow: 1_048_576 },
    ]);

    const { lookupContextTokens, resolveContextTokensForModel } = await import("./context.js");
    lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview");
    await flushAsyncWarmup();

    // Qualified "google-gemini-cli/gemini-3.1-pro-preview" → 1M wins over
    // bare "gemini-3.1-pro-preview" → 128k (cross-provider minimum).
    const result = resolveContextTokensForModel({
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(1_048_576);
  });
});
