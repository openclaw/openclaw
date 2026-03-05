import { beforeEach, describe, expect, it, vi } from "vitest";

describe("lookupContextTokens", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns configured model context window on first lookup", async () => {
    vi.doMock("../config/config.js", () => ({
      loadConfig: () => ({
        models: {
          providers: {
            openrouter: {
              models: [{ id: "openrouter/claude-sonnet", contextWindow: 321_000 }],
            },
          },
        },
      }),
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

    const { lookupContextTokens } = await import("./context.js");
    expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(321_000);
  });

  it("prefers provider-qualified discovered context windows when provider is known", async () => {
    vi.doMock("../config/config.js", () => ({
      loadConfig: () => ({ models: {} }),
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
        getAll: () => [
          { provider: "anthropic", id: "claude-sonnet", contextWindow: 1_000_000 },
          { provider: "openrouter", id: "claude-sonnet", contextWindow: 200_000 },
        ],
      })),
    }));

    const { lookupContextTokens, resolveContextTokensForModel } = await import("./context.js");
    await vi.waitFor(() => {
      expect(lookupContextTokens("anthropic/claude-sonnet")).toBe(1_000_000);
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(200_000);
    });

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
    vi.doMock("../config/config.js", () => ({
      loadConfig: () => ({
        models: {
          providers: {
            customprovider: {
              models: [{ id: "llama-3.1-8b", contextWindow: 131_072 }],
            },
          },
        },
      }),
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
        getAll: () => [{ provider: "customprovider", id: "llama-3.1-8b", contextWindow: 8_192 }],
      })),
    }));

    const { resolveContextTokensForModel } = await import("./context.js");

    await vi.waitFor(() => {
      expect(
        resolveContextTokensForModel({
          provider: "customprovider",
          model: "llama-3.1-8b",
          fallbackContextTokens: 4_096,
        }),
      ).toBe(131_072);
    });
  });

  it("does not skip eager warmup when --profile is followed by -- terminator", async () => {
    const loadConfigMock = vi.fn(() => ({ models: {} }));
    vi.doMock("../config/config.js", () => ({
      loadConfig: loadConfigMock,
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

    vi.doMock("../config/config.js", () => ({
      loadConfig: loadConfigMock,
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
});
