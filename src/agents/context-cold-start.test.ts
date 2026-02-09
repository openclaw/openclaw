import { describe, expect, it, vi } from "vitest";

// Mock the async model discovery to never populate the cache — simulating the
// cold-start race condition where lookupContextTokens is called before the
// async discovery completes.
vi.mock("./pi-model-discovery.js", async () => ({
  discoverAuthStorage: () => ({}),
  discoverModels: () => ({ getAll: () => [] }),
}));
vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: async () => {},
}));
vi.mock("./agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/test-agent",
}));

// Mock loadConfig to return a config with known model entries.
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      models: {
        providers: {
          openrouter: {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "openrouter/my-model",
                name: "My Model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
          anthropic: {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "anthropic/claude-opus-4-6",
                name: "Opus",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 32_000,
              },
            ],
          },
        },
      },
    }),
  };
});

import { lookupContextTokens } from "./context.js";

describe("lookupContextTokens", () => {
  it("returns config contextWindow on cold start (async cache empty)", () => {
    // The async MODEL_CACHE is empty because discoverModels returns [].
    // lookupContextTokens should fall back to reading from config.
    expect(lookupContextTokens("openrouter/my-model")).toBe(128_000);
  });

  it("returns config contextWindow for a different provider", () => {
    expect(lookupContextTokens("anthropic/claude-opus-4-6")).toBe(1_000_000);
  });

  it("returns undefined for unknown model id", () => {
    expect(lookupContextTokens("unknown/model")).toBeUndefined();
  });

  it("returns undefined when modelId is not provided", () => {
    expect(lookupContextTokens()).toBeUndefined();
    expect(lookupContextTokens(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string modelId", () => {
    expect(lookupContextTokens("")).toBeUndefined();
  });
});
