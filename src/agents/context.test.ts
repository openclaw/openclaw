import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CONTEXT_1M_TOKENS,
  applyConfiguredContextWindows,
  applyDiscoveredContextWindows,
  resolveContextTokensForModel,
} from "./context.js";
import { createSessionManagerRuntimeRegistry } from "./pi-extensions/session-manager-runtime-registry.js";

describe("applyDiscoveredContextWindows", () => {
  it("keeps the smallest raw fallback while storing provider-scoped entries independently", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "gemini-3-flash", provider: "google", contextWindow: 1_000_000 },
        { id: "gemini-3-flash", provider: "github-copilot", contextWindow: 128_000 },
      ],
    });

    // Raw fallback stays conservative.
    expect(cache.get("gemini-3-flash")).toBe(128_000);
    // Provider-aware callers can still recover the correct scoped limit.
    expect(cache.get("google::gemini-3-flash")).toBe(1_000_000);
    expect(cache.get("github-copilot::gemini-3-flash")).toBe(128_000);
  });

  it("preserves raw slash-containing discovery ids", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "github-copilot/gemini-3.1-pro-preview", contextWindow: 128_000 },
        { id: "google-gemini-cli/gemini-3.1-pro-preview", contextWindow: 1_048_576 },
      ],
    });

    expect(cache.get("github-copilot/gemini-3.1-pro-preview")).toBe(128_000);
    expect(cache.get("google-gemini-cli/gemini-3.1-pro-preview")).toBe(1_048_576);
  });
});

describe("applyConfiguredContextWindows", () => {
  it("keeps config authoritative without overwriting unrelated raw discovery ids", () => {
    const cache = new Map<string, number>([["openrouter/anthropic/claude-opus-4-6", 1_000_000]]);
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ id: "anthropic/claude-opus-4-6", contextWindow: 200_000 }],
          },
        },
      },
    });

    expect(cache.get("anthropic/claude-opus-4-6")).toBe(200_000);
    expect(cache.get("openrouter::anthropic/claude-opus-4-6")).toBe(200_000);
    // Raw discovery entry is untouched.
    expect(cache.get("openrouter/anthropic/claude-opus-4-6")).toBe(1_000_000);
  });

  it("adds scoped config entries without clobbering raw discovery keys", () => {
    const cache = new Map<string, number>();
    cache.set("google-gemini-cli/gemini-3.1-pro-preview", 1_048_576);
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          "google-gemini-cli": {
            models: [{ id: "gemini-3.1-pro-preview", contextWindow: 200_000 }],
          },
        },
      },
    });

    expect(cache.get("gemini-3.1-pro-preview")).toBe(200_000);
    expect(cache.get("google-gemini-cli::gemini-3.1-pro-preview")).toBe(200_000);
    expect(cache.get("google-gemini-cli/gemini-3.1-pro-preview")).toBe(1_048_576);
  });

  it("adds config-only model context windows and ignores invalid entries", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
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

    expect(cache.get("custom/model")).toBe(150_000);
    expect(cache.get("openrouter::custom/model")).toBe(150_000);
    expect(cache.has("bad/model")).toBe(false);
  });
});

describe("createSessionManagerRuntimeRegistry", () => {
  it("stores, reads, and clears values by object identity", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    const key = {};
    expect(registry.get(key)).toBeNull();
    registry.set(key, { value: 1 });
    expect(registry.get(key)).toEqual({ value: 1 });
    registry.set(key, null);
    expect(registry.get(key)).toBeNull();
  });

  it("ignores non-object keys", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    registry.set(null, { value: 1 });
    registry.set(123, { value: 1 });
    expect(registry.get(null)).toBeNull();
    expect(registry.get(123)).toBeNull();
  });
});

describe("resolveContextTokensForModel", () => {
  it("returns 1M context when anthropic context1m is enabled for opus/sonnet", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: { context1m: true },
              },
            },
          },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-6",
      fallbackContextTokens: 200_000,
    });

    expect(result).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it("does not force 1M context when context1m is not enabled", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {},
              },
            },
          },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-6",
      fallbackContextTokens: 200_000,
    });

    expect(result).toBe(200_000);
  });

  it("does not force 1M context for non-opus/sonnet Anthropic models", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-haiku-3-5": {
                params: { context1m: true },
              },
            },
          },
        },
      },
      provider: "anthropic",
      model: "claude-haiku-3-5",
      fallbackContextTokens: 200_000,
    });

    expect(result).toBe(200_000);
  });
});
