import { describe, expect, it } from "vitest";
import { parseModelRef } from "../model-selection.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Mirrors the provider-prefix stripping logic in runEmbeddedPiAgent (run.ts).
 * Extracted here so the guard condition can be unit-tested without the full
 * embedded-runner harness.
 */
function resolveProviderAndModel(params: { provider?: string; model?: string }): {
  provider: string;
  modelId: string;
} {
  let provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
  let modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  // Guard: only strip a provider prefix when params.provider was NOT set explicitly.
  // This prevents slash-delimited model IDs (e.g. "anthropic/claude-sonnet-4-5"
  // on OpenRouter) from being incorrectly split when the provider is already known.
  if (!params.provider && modelId.includes("/")) {
    const parsedRef = parseModelRef(modelId, provider);
    if (parsedRef) {
      provider = parsedRef.provider;
      modelId = parsedRef.model;
    }
  }

  return { provider, modelId };
}

describe("provider-prefix stripping in runEmbeddedPiAgent", () => {
  describe("strips provider prefix when params.provider is unset", () => {
    it("extracts provider from ollama-prefixed model ref", () => {
      const result = resolveProviderAndModel({
        model: "ollama-beelink2/qwen2.5-coder:7b",
      });
      expect(result.provider).toBe("ollama-beelink2");
      expect(result.modelId).toBe("qwen2.5-coder:7b");
    });

    it("extracts provider from openai-prefixed model ref", () => {
      const result = resolveProviderAndModel({
        model: "openai/gpt-5.4",
      });
      expect(result.provider).toBe("openai");
      expect(result.modelId).toBe("gpt-5.4");
    });

    it("extracts provider from anthropic-prefixed model ref", () => {
      const result = resolveProviderAndModel({
        model: "anthropic/claude-sonnet-4-6",
      });
      expect(result.provider).toBe("anthropic");
      expect(result.modelId).toBe("claude-sonnet-4-6");
    });

    it("leaves simple model IDs (no slash) unchanged", () => {
      const result = resolveProviderAndModel({
        model: "claude-sonnet-4-6",
      });
      expect(result.provider).toBe("anthropic");
      expect(result.modelId).toBe("claude-sonnet-4-6");
    });
  });

  describe("preserves slash-delimited model IDs when params.provider is explicitly set", () => {
    it("does not split OpenRouter model anthropic/claude-sonnet-4-5", () => {
      const result = resolveProviderAndModel({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-5",
      });
      expect(result.provider).toBe("openrouter");
      expect(result.modelId).toBe("anthropic/claude-sonnet-4-5");
    });

    it("does not split openrouter/auto self-prefixed model ID", () => {
      const result = resolveProviderAndModel({
        provider: "openrouter",
        model: "openrouter/auto",
      });
      expect(result.provider).toBe("openrouter");
      expect(result.modelId).toBe("openrouter/auto");
    });

    it("does not split OpenRouter model google/gemini-2.5-pro", () => {
      const result = resolveProviderAndModel({
        provider: "openrouter",
        model: "google/gemini-2.5-pro",
      });
      expect(result.provider).toBe("openrouter");
      expect(result.modelId).toBe("google/gemini-2.5-pro");
    });

    it("preserves explicitly set provider even with slash-delimited model", () => {
      const result = resolveProviderAndModel({
        provider: "ollama-beelink2",
        model: "library/llama3:latest",
      });
      expect(result.provider).toBe("ollama-beelink2");
      expect(result.modelId).toBe("library/llama3:latest");
    });
  });
});
