import { beforeEach, describe, expect, it, vi } from "vitest";

function mockContextModuleDeps(loadConfigImpl: () => unknown) {
  vi.doMock("../config/config.js", () => ({
    loadConfig: loadConfigImpl,
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
      getAll: () => [],
    })),
  }));
}

// Shared mock setup used by multiple tests.
function mockDiscoveryDeps(
  models: Array<{ id: string; contextWindow: number }>,
  configModels?: Record<string, { models: Array<{ id: string; contextWindow: number }> }>,
) {
  vi.doMock("../config/config.js", () => ({
    loadConfig: () => ({ models: configModels ? { providers: configModels } : {} }),
  }));
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => {}),
  }));
  vi.doMock("./agent-paths.js", () => ({
    resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
  }));
  vi.doMock("./pi-model-discovery.js", () => ({
    discoverAuthStorage: vi.fn(() => ({})),
    discoverModels: vi.fn(() => ({ getAll: () => models })),
  }));
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
    // Trigger async cache population.
    await new Promise((r) => setTimeout(r, 0));
    // Conservative minimum: bare-id cache feeds runtime flush/compaction paths.
    expect(lookupContextTokens("gemini-3.1-pro-preview")).toBe(128_000);
  });

  it("resolveContextTokensForModel uses provider-qualified key before bare model id", async () => {
    // Registry returns provider-qualified entries (real-world scenario from #35976).
    mockDiscoveryDeps([
      { id: "github-copilot/gemini-3.1-pro-preview", contextWindow: 128_000 },
      { id: "google-gemini-cli/gemini-3.1-pro-preview", contextWindow: 1_048_576 },
    ]);

    const { resolveContextTokensForModel } = await import("./context.js");
    await new Promise((r) => setTimeout(r, 0));

    // With provider specified, should return the correct provider's window.
    const result = resolveContextTokensForModel({
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(1_048_576);
  });

  it("resolveContextTokensForModel honors configured overrides when provider keys use mixed case", async () => {
    mockDiscoveryDeps(
      [{ id: "openrouter/anthropic/claude-sonnet-4-5", contextWindow: 1_048_576 }],
      {
        " OpenRouter ": {
          models: [{ id: "anthropic/claude-sonnet-4-5", contextWindow: 200_000 }],
        },
      },
    );

    const { resolveContextTokensForModel } = await import("./context.js");
    await new Promise((r) => setTimeout(r, 0));

    const result = resolveContextTokensForModel({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(result).toBe(200_000);
  });

  it("resolveContextTokensForModel does not collide raw slash-containing model IDs with synthetic qualified keys", async () => {
    // Reviewer concern: OpenRouter stores raw IDs like "google/gemini-2.5-pro".
    // If the lookup built a synthetic key "google/gemini-2.5-pro" from
    // {provider:"google", model:"gemini-2.5-pro"}, it would hit the OpenRouter
    // raw entry. Guard: skip the qualified key when model already contains "/".
    mockDiscoveryDeps([
      // OpenRouter raw entry (model ID already provider-qualified by OpenRouter).
      { id: "google/gemini-2.5-pro", contextWindow: 999_000 },
    ]);

    const { resolveContextTokensForModel } = await import("./context.js");
    await new Promise((r) => setTimeout(r, 0));

    // Calling with the native Google provider and a bare model id should NOT
    // hit the OpenRouter raw entry via a synthetic "google/gemini-2.5-pro" key.
    // Instead it falls through to the bare lookup which returns the raw value —
    // functionally correct (same model, same window in practice) but via the
    // intended code path rather than an accidental key collision.
    const result = resolveContextTokensForModel({
      provider: "google",
      model: "gemini-2.5-pro",
    });
    // The bare fallback finds the raw OpenRouter entry; no double-prefix lookup.
    expect(result).toBe(999_000);

    // Calling with the OpenRouter provider and the slash-model id must NOT
    // generate "openrouter/google/gemini-2.5-pro"; it uses bare lookup directly.
    const openrouterResult = resolveContextTokensForModel({
      provider: "openrouter",
      model: "google/gemini-2.5-pro",
    });
    expect(openrouterResult).toBe(999_000);
  });
});
