import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { createProviderDynamicModelContext } from "../test-support/provider-model-test-helpers.js";
import featherlessPlugin from "./index.js";
import * as models from "./models.js";
import { applyFeatherlessConfig } from "./onboard.js";

function createRuntimeModel(overrides: Partial<ProviderRuntimeModel> = {}): ProviderRuntimeModel {
  return {
    id: models.FEATHERLESS_DEFAULT_MODEL_ID,
    name: "Qwen3 32B",
    provider: "featherless",
    api: "openai-responses",
    baseUrl: "https://models.example.test/v1",
    headers: { "X-Route": "custom-template" },
    reasoning: true,
    input: ["text"],
    cost: { input: 0.102, output: 0.493, cacheRead: 0, cacheWrite: 0 },
    contextWindow: models.FEATHERLESS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: models.FEATHERLESS_DEFAULT_MAX_TOKENS,
    compat: { thinkingFormat: "qwen-chat-template" },
    ...overrides,
  };
}

async function resolveModel(modelId: string, catalog: ProviderRuntimeModel[]) {
  const provider = await registerSingleProviderPlugin(featherlessPlugin);
  return provider.resolveDynamicModel?.(
    createProviderDynamicModelContext({ provider: "featherless", modelId, models: catalog }),
  );
}

describe("featherless provider plugin", () => {
  it("applies the curated default during onboarding", () => {
    const defaults = applyFeatherlessConfig({}).agents?.defaults;
    expect(resolveAgentModelPrimaryValue(defaults?.model)).toBe(
      models.FEATHERLESS_DEFAULT_MODEL_REF,
    );
    expect(defaults?.models?.[models.FEATHERLESS_DEFAULT_MODEL_REF]?.alias).toBe("Qwen3 32B");
  });
  it.each(["custom", "missing"] as const)(
    "resolves arbitrary Featherless model ids with a %s template",
    async (source) => {
      const template = createRuntimeModel();
      const missing = source === "missing";
      const resolved = await resolveModel("moonshotai/Kimi-K2-Instruct", missing ? [] : [template]);
      expect(resolved).toMatchObject({
        id: "moonshotai/Kimi-K2-Instruct",
        provider: "featherless",
        api: missing ? "openai-completions" : template.api,
        baseUrl: missing ? models.FEATHERLESS_BASE_URL : template.baseUrl,
        reasoning: false,
        input: ["text"],
        contextWindow: models.FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
        maxTokens: models.FEATHERLESS_DYNAMIC_MAX_TOKENS,
        compat: models.FEATHERLESS_DYNAMIC_COMPAT,
        cost: missing ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : template.cost,
      });
      expect(resolved?.headers).toEqual(missing ? undefined : template.headers);
    },
  );
  it("applies provider compat to configured models without overriding explicit values", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const normalized = provider.normalizeResolvedModel?.({
      provider: "featherless",
      modelId: "google/gemma-3-27b-it",
      model: createRuntimeModel({
        id: "google/gemma-3-27b-it",
        name: "Gemma 3 27B",
        compat: { supportsStore: true, thinkingFormat: "deepseek" },
      }),
    });
    expect(normalized?.compat).toMatchObject({
      ...models.FEATHERLESS_DYNAMIC_COMPAT,
      supportsStore: true,
      thinkingFormat: "deepseek",
    });
  });
  it("defers the curated model to static catalog resolution", async () => {
    expect(
      await resolveModel(models.FEATHERLESS_DEFAULT_MODEL_ID, [createRuntimeModel()]),
    ).toBeUndefined();
  });
  it("preserves Featherless reasoning during replay", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "featherless",
      modelApi: "openai-completions",
      modelId: models.FEATHERLESS_DEFAULT_MODEL_ID,
    });
    expect(policy).toBeDefined();
    expect(policy).not.toHaveProperty("dropReasoningFromHistory");
  });
});
