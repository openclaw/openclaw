import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  ANTHROPIC_CONTEXT_1M_TOKENS,
  applyConfiguredContextWindows,
  applyDiscoveredContextWindows,
  resolveContextTokensForModel,
} from "./context.js";
import { createSessionManagerRuntimeRegistry } from "./pi-extensions/session-manager-runtime-registry.js";

function makeModel(id: string, contextWindow: number): ModelDefinitionConfig {
  return {
    id,
    name: id,
    contextWindow,
    maxTokens: Math.min(contextWindow, 128_000),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
  };
}

describe("applyDiscoveredContextWindows", () => {
  it("keeps the smallest context window when duplicate model ids are discovered", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "claude-sonnet-4-5", contextWindow: 1_000_000 },
        { id: "claude-sonnet-4-5", contextWindow: 200_000 },
      ],
    });

    expect(cache.get("claude-sonnet-4-5")).toBe(200_000);
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

  it("caps override by known model context window", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              baseUrl: "https://example.com/v1",
              models: [makeModel("gpt-5.4", 900_000)],
            },
          },
        },
      },
      contextTokensOverride: 1_048_000,
      provider: "openai-codex",
      model: "gpt-5.4",
      fallbackContextTokens: 200_000,
    });

    expect(result).toBe(900_000);
  });

  it("prefers lower override when it is already below the model context window", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              baseUrl: "https://example.com/v1",
              models: [makeModel("gpt-5.4", 900_000)],
            },
          },
        },
      },
      contextTokensOverride: 128_000,
      provider: "openai-codex",
      model: "gpt-5.4",
      fallbackContextTokens: 200_000,
    });

    expect(result).toBe(128_000);
  });

  it("caps override when provider alias resolves to a configured provider entry", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://bedrock.example.com",
              models: [makeModel("us.anthropic.claude-opus-4-6-v1", 200_000)],
            },
          },
        },
      },
      contextTokensOverride: 1_048_000,
      provider: "bedrock",
      model: "us.anthropic.claude-opus-4-6-v1",
      fallbackContextTokens: 100_000,
    });

    expect(result).toBe(200_000);
  });
});
