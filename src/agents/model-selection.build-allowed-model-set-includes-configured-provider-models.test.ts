import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildAllowedModelSet, modelKey } from "./model-selection.js";

describe("buildAllowedModelSet", () => {
  it("includes models from explicitly configured providers in allowAny mode", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "ollama-local",
            api: "openai-completions",
            models: [
              {
                id: "qwen2.5:7b",
                name: "Qwen 2.5 7B",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32768,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };

    // No agents.defaults.models → allowAny = true
    const catalog = [{ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" }];

    const result = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });

    expect(result.allowAny).toBe(true);
    // The Ollama model should be in allowedKeys even though it's not in the catalog
    expect(result.allowedKeys.has(modelKey("ollama", "qwen2.5:7b"))).toBe(true);
    // Catalog model should also be present
    expect(result.allowedKeys.has(modelKey("anthropic", "claude-opus-4-5"))).toBe(true);
  });

  it("includes models from custom-named providers (e.g. 'local') in allowAny mode", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "ollama-local",
            api: "openai-responses",
            models: [
              {
                id: "qwen2.5:7b",
                name: "Qwen 2.5 7B",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32768,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };

    const catalog = [{ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" }];

    const result = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });

    expect(result.allowAny).toBe(true);
    expect(result.allowedKeys.has(modelKey("local", "qwen2.5:7b"))).toBe(true);
  });

  it("does not break when providers have no models array", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "ollama-local",
            api: "openai-completions",
            // no models array
          },
        },
      },
    };

    const catalog = [{ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" }];

    const result = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });

    expect(result.allowAny).toBe(true);
    // Should not crash, just no extra keys
    expect(result.allowedKeys.has(modelKey("anthropic", "claude-opus-4-5"))).toBe(true);
  });
});
