import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { TOGETHER_MODEL_CATALOG } from "./models.js";
import { applyTogetherConfig, TOGETHER_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Together onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyTogetherConfig({});

    expect(config.models?.providers?.together?.models.map((model) => model.id)).toEqual(
      TOGETHER_MODEL_CATALOG.map((model) => model.id),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      TOGETHER_DEFAULT_MODEL_REF,
    );
    expect(TOGETHER_DEFAULT_MODEL_REF).toBe(
      `together/${manifest.modelCatalog.providers.together.defaultModel}`,
    );
    expect(TOGETHER_DEFAULT_MODEL_REF).toBe("together/moonshotai/Kimi-K2.6");
    expect(config.agents?.defaults?.models?.[TOGETHER_DEFAULT_MODEL_REF]).toEqual({
      alias: "Together AI",
    });
  });
});

describe("Together prompt cache routing", () => {
  it.each([
    { baseUrl: "https://api.together.xyz/v1", key: "synthetic-session" },
    { baseUrl: "https://api.together.ai/v1/", key: "synthetic-session" },
    { baseUrl: "https://proxy.example/v1", key: undefined },
    { baseUrl: "https://api.together.ai/custom/v1", key: undefined },
    { baseUrl: "https://api.together.xyz/v1", optOut: true, key: undefined },
  ])("sends native cache affinity at $baseUrl with optOut=$optOut", async (route) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model: Model = {
      id: "synthetic-model",
      name: "Synthetic model",
      provider: "together",
      api: "openai-completions",
      baseUrl: route.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 128,
      ...(route.optOut ? { compat: { supportsPromptCacheKey: false } } : {}),
    };
    const normalized =
      provider.normalizeResolvedModel?.({
        provider: model.provider,
        modelId: model.id,
        model,
      }) ?? model;
    let payload: unknown;
    const result = await streamSimple(
      normalized,
      { messages: [] },
      {
        apiKey: "synthetic-unused-key",
        sessionId: "synthetic-session",
        cacheRetention: "long",
        onPayload(value) {
          payload = value;
          throw new Error("captured before request");
        },
      },
    ).result();
    expect(result.errorMessage).toBe("captured before request");
    expect(payload).toMatchObject({ prompt_cache_key: route.key });
    expect(payload).not.toHaveProperty("prompt_cache_retention");
    expect(payload).not.toHaveProperty("prompt_cache_options");
  });
});
