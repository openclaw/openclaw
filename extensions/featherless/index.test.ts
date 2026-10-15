import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { createProviderDynamicModelContext } from "../test-support/provider-model-test-helpers.js";
import featherlessPlugin from "./index.js";
import {
  FEATHERLESS_BASE_URL,
  FEATHERLESS_DEFAULT_CONTEXT_WINDOW,
  FEATHERLESS_DEFAULT_MAX_TOKENS,
  FEATHERLESS_DEFAULT_MODEL_ID,
  FEATHERLESS_DEFAULT_MODEL_REF,
  FEATHERLESS_DYNAMIC_COMPAT,
  FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
  FEATHERLESS_DYNAMIC_MAX_TOKENS,
} from "./models.js";
import { applyFeatherlessConfig } from "./onboard.js";

function createDefaultRuntimeModel(): ProviderRuntimeModel {
  return {
    id: FEATHERLESS_DEFAULT_MODEL_ID,
    name: "Qwen3 32B",
    provider: "featherless",
    api: "openai-completions",
    baseUrl: FEATHERLESS_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.102, output: 0.493, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FEATHERLESS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: FEATHERLESS_DEFAULT_MAX_TOKENS,
    compat: { thinkingFormat: "qwen-chat-template" },
  };
}

describe("featherless provider plugin", () => {
  it("applies the curated default during onboarding", () => {
    const config = applyFeatherlessConfig({});

    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      FEATHERLESS_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models?.[FEATHERLESS_DEFAULT_MODEL_REF]?.alias).toBe(
      "Qwen3 32B",
    );
  });

  it.each(["custom", "missing"] as const)(
    "resolves arbitrary Featherless model ids with a %s template",
    async (source) => {
      const provider = await registerSingleProviderPlugin(featherlessPlugin);
      const template = createDefaultRuntimeModel();
      template.api = "openai-responses";
      template.baseUrl = "https://models.example.test/v1";
      template.headers = { "X-Route": "custom-template" };
      const resolved = provider.resolveDynamicModel?.(
        createProviderDynamicModelContext({
          provider: "featherless",
          modelId: "moonshotai/Kimi-K2-Instruct",
          models: source === "missing" ? [] : [template],
        }),
      );

      expect(resolved).toMatchObject({
        id: "moonshotai/Kimi-K2-Instruct",
        provider: "featherless",
        api: source === "missing" ? "openai-completions" : template.api,
        baseUrl: source === "missing" ? FEATHERLESS_BASE_URL : template.baseUrl,
        reasoning: false,
        input: ["text"],
        contextWindow: FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
        maxTokens: FEATHERLESS_DYNAMIC_MAX_TOKENS,
        compat: FEATHERLESS_DYNAMIC_COMPAT,
        cost:
          source === "missing"
            ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            : template.cost,
      });
      expect(resolved?.headers).toEqual(source === "missing" ? undefined : template.headers);
    },
  );

  it("applies provider compat to configured models without overriding explicit values", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const normalized = provider.normalizeResolvedModel?.({
      provider: "featherless",
      modelId: "google/gemma-3-27b-it",
      model: {
        ...createDefaultRuntimeModel(),
        id: "google/gemma-3-27b-it",
        name: "Gemma 3 27B",
        compat: {
          supportsStore: true,
          thinkingFormat: "deepseek",
        },
      },
    });

    expect(normalized?.compat).toMatchObject({
      ...FEATHERLESS_DYNAMIC_COMPAT,
      supportsStore: true,
      thinkingFormat: "deepseek",
    });
  });

  it("defers the curated model to static catalog resolution", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "featherless",
        modelId: FEATHERLESS_DEFAULT_MODEL_ID,
        models: [createDefaultRuntimeModel()],
      }),
    );

    expect(resolved).toBeUndefined();
  });

  it("preserves Featherless reasoning during replay", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "featherless",
      modelApi: "openai-completions",
      modelId: FEATHERLESS_DEFAULT_MODEL_ID,
    });

    expect(policy).toBeDefined();
    expect(policy).not.toHaveProperty("dropReasoningFromHistory");
  });
});
