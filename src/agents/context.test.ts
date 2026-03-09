import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CONTEXT_1M_TOKENS,
  applyConfiguredContextWindows,
  applyDiscoveredContextWindows,
  resolveContextTokensForModel,
} from "./context.js";
import { createSessionManagerRuntimeRegistry } from "./pi-extensions/session-manager-runtime-registry.js";

describe("applyDiscoveredContextWindows", () => {
  it("keeps the smallest context window when the same bare model id appears under multiple providers", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
        { id: "gemini-3.1-pro-preview", contextWindow: 1_048_576 },
      ],
    });

    // Keep the conservative (minimum) value: this cache feeds runtime paths such
    // as flush thresholds and session persistence, not just /status display.
    // Callers with a known provider should use resolveContextTokensForModel which
    // tries the provider-qualified key first.
    expect(cache.get("gemini-3.1-pro-preview")).toBe(128_000);
  });

  it("stores provider-qualified entries independently", () => {
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
  it("overrides discovered cache values with explicit models.providers contextWindow", () => {
    const cache = new Map<string, number>([["anthropic/claude-opus-4-6", 1_000_000]]);
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
    // Qualified key must also be written so resolveContextTokensForModel
    // (which tries the qualified key first) returns the config override, not
    // the discovered value stored at "openrouter/anthropic/claude-opus-4-6".
    expect(cache.get("openrouter/anthropic/claude-opus-4-6")).toBe(200_000);
  });

  it("stores provider-qualified key so config overrides beat qualified discovery entries (bare model id)", () => {
    // Discovery emits provider-qualified IDs; config uses bare IDs.
    // Without the qualified key in cache, resolveContextTokensForModel
    // (which tries the qualified key first) would return the discovered value.
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
    expect(cache.get("google-gemini-cli/gemini-3.1-pro-preview")).toBe(200_000);
  });

  it("stores provider-qualified key so config overrides beat qualified discovery entries (slash model id)", () => {
    // OpenRouter model ids already contain a slash (e.g. "anthropic/claude-sonnet-4-5").
    // Discovery may store these under the fully-qualified "openrouter/anthropic/claude-sonnet-4-5"
    // key. resolveContextTokensForModel tries the qualified key first, so the config
    // override must also be written to that key — not skipped because modelId includes "/".
    const cache = new Map<string, number>();
    cache.set("openrouter/anthropic/claude-sonnet-4-5", 1_048_576);
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ id: "anthropic/claude-sonnet-4-5", contextWindow: 200_000 }],
          },
        },
      },
    });

    // Bare key override must be present.
    expect(cache.get("anthropic/claude-sonnet-4-5")).toBe(200_000);
    // Qualified key must also be overridden so the qualified-first lookup in
    // resolveContextTokensForModel returns the config value, not the discovered one.
    expect(cache.get("openrouter/anthropic/claude-sonnet-4-5")).toBe(200_000);
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
