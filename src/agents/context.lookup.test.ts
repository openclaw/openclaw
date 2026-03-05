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
});
