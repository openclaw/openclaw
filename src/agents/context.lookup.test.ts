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
    expect(await lookupContextTokens("openrouter/claude-sonnet")).toBe(321_000);
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
      expect(await lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
      expect(await lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await lookupContextTokens("openrouter/claude-sonnet")).toBe(654_321);
      expect(loadConfigMock).toHaveBeenCalledTimes(2);
    } finally {
      process.argv = argvSnapshot;
      vi.useRealTimers();
    }
  });

  it("cold-start: awaits discovered context window from async model discovery", async () => {
    // Simulate a delayed async phase (ensureOpenClawModelsJson takes time) so that
    // the MODEL_CACHE is not yet populated when lookupContextTokens is first called.
    let resolveModelsJson!: () => void;
    const modelsJsonDelay = new Promise<void>((resolve) => {
      resolveModelsJson = resolve;
    });

    vi.doMock("../config/config.js", () => ({
      loadConfig: () => ({ models: {} }), // no config-level context windows
    }));
    vi.doMock("./models-config.js", () => ({
      ensureOpenClawModelsJson: vi.fn(async () => {
        await modelsJsonDelay; // block the async phase until we release it
      }),
    }));
    vi.doMock("./agent-paths.js", () => ({
      resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
    }));
    vi.doMock("./pi-model-discovery.js", () => ({
      discoverAuthStorage: vi.fn(() => ({})),
      discoverModels: vi.fn(() => ({
        getAll: () => [{ id: "vertex/gemini-discovered", contextWindow: 2_097_152 }],
      })),
    }));

    // config validate mode: skip eager warmup so loadPromise starts null
    const argvSnapshot = process.argv;
    process.argv = ["node", "openclaw", "config", "validate"];
    try {
      const { lookupContextTokens } = await import("./context.js");

      // Start the lookup before discovery completes — async fix must await it.
      const lookupPromise = lookupContextTokens("vertex/gemini-discovered");

      // Now release the delayed discovery phase.
      resolveModelsJson();

      expect(await lookupPromise).toBe(2_097_152);
    } finally {
      process.argv = argvSnapshot;
    }
  });
});
