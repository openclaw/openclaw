import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("lookupContextTokens", () => {
  let lookupContextTokens: (modelId?: string) => number | undefined;

  beforeEach(async () => {
    vi.resetModules();
    // Mock the async model discovery so it never populates MODEL_CACHE.
    vi.mock("./pi-model-discovery.js", () => {
      throw new Error("not available in test");
    });
    // Mock loadConfig to return a known provider config.
    vi.mock("../config/config.js", () => ({
      loadConfig: () => ({
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [
                { id: "claude-opus-4-6", contextWindow: 1_000_000, maxTokens: 32768 },
                { id: "claude-haiku-4-5", contextWindow: 200_000, maxTokens: 8192 },
              ],
            },
          },
        },
      }),
    }));
    const mod = await import("./context.js");
    lookupContextTokens = mod.lookupContextTokens;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns contextWindow from config when async cache is empty", () => {
    expect(lookupContextTokens("claude-opus-4-6")).toBe(1_000_000);
  });

  it("returns contextWindow for another model", () => {
    expect(lookupContextTokens("claude-haiku-4-5")).toBe(200_000);
  });

  it("returns undefined for unknown model", () => {
    expect(lookupContextTokens("unknown-model")).toBeUndefined();
  });

  it("returns undefined for empty modelId", () => {
    expect(lookupContextTokens("")).toBeUndefined();
    expect(lookupContextTokens(undefined)).toBeUndefined();
  });
});
