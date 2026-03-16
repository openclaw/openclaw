import { beforeEach, describe, expect, it, vi } from "vitest";

type DiscoveredModel = { id: string; contextWindow: number };

function mockContextDeps(params: {
  loadConfig: () => unknown;
  discoveredModels?: DiscoveredModel[];
}) {
  vi.doMock("../config/config.js", () => ({
    loadConfig: params.loadConfig,
  }));
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => {}),
  }));
  vi.doMock("./agent-paths.js", () => ({
    resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
  }));
  vi.doMock("./pi-model-discovery.js", () => ({
    discoverAuthStorage: vi.fn(() => ({})),
    discoverModels: vi.fn(() => ({
      getAll: () => params.discoveredModels ?? [],
    })),
  }));
}

function mockContextModuleDeps(loadConfigImpl: () => unknown) {
  mockContextDeps({ loadConfig: loadConfigImpl });
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

async function importResolveContextTokensForModel() {
  const { resolveContextTokensForModel } = await import("./context.js");
  await new Promise((r) => setTimeout(r, 0));
  return resolveContextTokensForModel;
}

describe("lookupContextTokens", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("./pi-model-discovery-runtime.js");
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

  it("does not skip eager warmup when --profile is followed by -- terminator", async () => {
    const loadConfigMock = vi.fn(() => ({ models: {} }));
    mockContextModuleDeps(loadConfigMock);

    const argvSnapshot = process.argv;
    process.argv = ["node", "openclaw", "--profile", "--", "config", "validate"];
    try {
      await import("./context.js");
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = argvSnapshot;
    }
  });

  it("skips eager warmup for logs commands that do not need model metadata at startup", async () => {
    const loadConfigMock = vi.fn(() => ({ models: {} }));
    mockContextModuleDeps(loadConfigMock);

    const argvSnapshot = process.argv;
    process.argv = ["node", "openclaw", "logs", "--limit", "5"];
    try {
      await import("./context.js");
      expect(loadConfigMock).not.toHaveBeenCalled();
    } finally {
      process.argv = argvSnapshot;
    }
  });

  it("skips eager warmup for status commands that only read model metadata opportunistically", async () => {
    const loadConfigMock = vi.fn(() => ({ models: {} }));
    mockContextModuleDeps(loadConfigMock);

    const argvSnapshot = process.argv;
    process.argv = ["node", "openclaw", "status", "--json"];
    try {
      await import("./context.js");
      expect(loadConfigMock).not.toHaveBeenCalled();
    } finally {
      process.argv = argvSnapshot;
    }
  });

  it("does not lazy-load pi model discovery during status lookups", async () => {
    const loadConfigMock = vi.fn(() => ({
      models: {
        providers: {
          openrouter: {
            models: [{ id: "openrouter/claude-sonnet", contextWindow: 321_000 }],
          },
        },
      },
    }));
    mockContextModuleDeps(loadConfigMock);
    vi.doMock("./pi-model-discovery-runtime.js", () => {
      throw new Error("status lookups must not import pi model discovery");
    });

    const argvSnapshot = process.argv;
    process.argv = ["node", "openclaw", "status", "--json"];
    try {
      const { lookupContextTokens } = await import("./context.js");
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(321_000);
    } finally {
      process.argv = argvSnapshot;
    }
  });

  it("skips eager warmup for gateway commands that do not need model metadata at startup", async () => {
    const loadConfigMock = vi.fn(() => ({ models: {} }));
    mockContextModuleDeps(loadConfigMock);

    const argvSnapshot = process.argv;
    process.argv = ["node", "openclaw", "gateway", "status", "--json"];
    try {
      await import("./context.js");
      expect(loadConfigMock).not.toHaveBeenCalled();
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

    const argvSnapshot = process.argv;
    process.argv = ["node", "openclaw", "config", "validate"];
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
      process.argv = argvSnapshot;
      vi.useRealTimers();
    }
  });

  it("returns the smaller window when the same bare model id is discovered under multiple providers", async () => {
    mockDiscoveryDeps([
      { id: "gemini-3.1-pro-preview", contextWindow: 1_048_576 },
      { id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
    ]);

    const { lookupContextTokens } = await import("./context.js");
    await vi.waitFor(() => expect(lookupContextTokens("gemini-3.1-pro-preview")).toBe(128_000), {
      timeout: 3_000,
    });
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
    await vi.waitFor(
      () => expect(lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview")).toBe(1_048_576),
      { timeout: 3_000 },
    );

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
    await vi.waitFor(() => expect(lookupContextTokens("google/gemini-2.5-pro")).toBe(999_000), {
      timeout: 3_000,
    });

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
    await vi.waitFor(() => expect(lookupContextTokens("google/gemini-2.5-pro")).toBe(999_000), {
      timeout: 3_000,
    });

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
    await vi.waitFor(
      () => expect(lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview")).toBe(1_048_576),
      { timeout: 3_000 },
    );

    // Qualified "google-gemini-cli/gemini-3.1-pro-preview" → 1M wins over
    // bare "gemini-3.1-pro-preview" → 128k (cross-provider minimum).
    const result = resolveContextTokensForModel({
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(1_048_576);
  });
});
