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

  it("prefers provider-scoped cache values when provider/model are provided", async () => {
    vi.doMock("../config/config.js", () => ({
      loadConfig: () => ({
        models: {
          providers: {
            "github-copilot": {
              models: [{ id: "gemini-3.1-pro-preview", contextWindow: 128_000 }],
            },
            "google-gemini-cli": {
              models: [{ id: "gemini-3.1-pro-preview", contextWindow: 1_048_576 }],
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

    const { resolveContextTokensForModel } = await import("./context.js");
    expect(
      resolveContextTokensForModel({
        provider: "google-gemini-cli",
        model: "gemini-3.1-pro-preview",
      }),
    ).toBe(1_048_576);
    expect(
      resolveContextTokensForModel({
        provider: "github-copilot",
        model: "gemini-3.1-pro-preview",
      }),
    ).toBe(128_000);
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
