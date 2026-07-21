import type { Model } from "openclaw/plugin-sdk/llm";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import {
  createProviderDynamicModelContext,
  runSingleProviderCatalog,
} from "../test-support/provider-model-test-helpers.js";
import poolsidePlugin from "./index.js";
import { applyPoolsideConfig } from "./onboard.js";

const EXPECTED_MODEL_IDS = [
  "laguna-s-2.1",
  "laguna-s-2.1:fast",
  "laguna-xs-2.1",
  "laguna-xs-2.1:fast",
  "laguna-m.1",
  "laguna-m.1:fast",
];

type OpenAICompletionsModel = Model<"openai-completions">;

function poolsideRuntimeModel(id: string): ProviderRuntimeModel {
  return {
    id,
    name: id,
    provider: "poolside",
    api: "openai-completions",
    baseUrl: "https://inference.poolside.ai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 32_768,
  };
}

describe("poolside provider plugin", () => {
  it("registers Poolside with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(poolsidePlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "poolside-api-key",
    });

    expect(provider).toMatchObject({
      id: "poolside",
      label: "Poolside",
      docsPath: "/providers/poolside",
      envVars: ["POOLSIDE_API_KEY"],
      resolveDynamicModel: expect.any(Function),
      wrapStreamFn: expect.any(Function),
    });
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Poolside api-key auth choice");
    }
    expect(resolved.provider.id).toBe("poolside");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the static Laguna catalog", async () => {
    const provider = await registerSingleProviderPlugin(poolsidePlugin);
    const catalog = await runSingleProviderCatalog(provider);

    expect(catalog.api).toBe("openai-completions");
    expect(catalog.baseUrl).toBe("https://inference.poolside.ai/v1");
    const models = catalog.models;
    if (!models) {
      throw new Error("expected Poolside catalog models");
    }
    expect(models.map((model) => model.id)).toEqual(EXPECTED_MODEL_IDS);
    for (const model of models) {
      expect(model.reasoning).toBe(true);
      expect(model.input).toEqual(["text"]);
      expect(model.maxTokens).toBe(32_768);
      expect(model.compat?.supportsTools).toBe(true);
      expect(model.compat?.supportsReasoningEffort).toBe(false);
      expect(model.compat?.maxTokensField).toBe("max_tokens");
    }
    const fast = models.find((model) => model.id === "laguna-s-2.1:fast");
    expect(fast?.contextWindow).toBe(1_048_576);
    const s21 = models.find((model) => model.id === "laguna-s-2.1");
    expect(s21?.contextWindow).toBe(262_144);
  });

  it("onboards poolside/laguna-s-2.1 as the default model", () => {
    expect(resolveAgentModelPrimaryValue(applyPoolsideConfig({}).agents?.defaults?.model)).toBe(
      "poolside/laguna-s-2.1",
    );
  });

  it("resolves forward-compat Laguna model ids as reasoning text models", async () => {
    const provider = await registerSingleProviderPlugin(poolsidePlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "poolside",
        modelId: "laguna-s-2.2",
        models: [poolsideRuntimeModel("laguna-s-2.1")],
      }),
    );

    expect(resolved?.provider).toBe("poolside");
    expect(resolved?.id).toBe("laguna-s-2.2");
    expect(resolved?.api).toBe("openai-completions");
    expect(resolved?.baseUrl).toBe("https://inference.poolside.ai/v1");
    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.input).toEqual(["text"]);
    expect(resolved?.compat?.supportsReasoningEffort).toBe(false);
  });

  it("defers bundled catalog ids to core static-catalog resolution", async () => {
    const provider = await registerSingleProviderPlugin(poolsidePlugin);
    for (const modelId of EXPECTED_MODEL_IDS) {
      const resolved = provider.resolveDynamicModel?.(
        createProviderDynamicModelContext({
          provider: "poolside",
          modelId,
          models: [poolsideRuntimeModel(modelId)],
        }),
      );
      expect(resolved).toBeUndefined();
    }
  });

  it("never sends reasoning_effort for Laguna models", () => {
    const model = {
      id: "laguna-s-2.1",
      name: "Laguna S 2.1",
      provider: "poolside",
      api: "openai-completions",
      baseUrl: "https://inference.poolside.ai/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262_144,
      maxTokens: 32_768,
      compat: {
        supportsReasoningEffort: false,
        supportsTools: true,
        maxTokensField: "max_tokens" as const,
      },
    } as OpenAICompletionsModel;

    const payload = buildOpenAICompletionsParams(
      model,
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      },
      { reasoning: "high", maxTokens: 64 },
    );

    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.max_tokens).toBe(64);
  });

  it("keeps reasoning replay history for Laguna models", async () => {
    const provider = await registerSingleProviderPlugin(poolsidePlugin);
    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "laguna-s-2.1",
      } as never)?.dropReasoningFromHistory,
    ).not.toBe(true);
  });
});
