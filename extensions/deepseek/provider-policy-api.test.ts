import { expectDefined } from "@openclaw/normalization-core";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { normalizeConfig, resolveThinkingProfile } from "./provider-policy-api.js";

function requireModel(config: ModelProviderConfig, index: number) {
  return expectDefined(config.models[index], `DeepSeek provider model ${index}`);
}

function configWithModels(...models: ModelProviderConfig["models"]): ModelProviderConfig {
  return { baseUrl: "https://api.deepseek.com", api: "openai-completions", models };
}

function model(
  id: string,
  overrides: Partial<ModelProviderConfig["models"][number]> = {},
): ModelProviderConfig["models"][number] {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    ...overrides,
  };
}

describe("deepseek provider-policy-api", () => {
  it("advertises max thinking levels for DeepSeek V4 models", () => {
    const profile = (modelId: string, provider = "deepseek") =>
      resolveThinkingProfile({ provider, modelId });
    expect(profile("deepseek-v4-pro")?.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(profile("deepseek-v4-flash")?.defaultLevel).toBe("high");
    expect(profile("deepseek-chat")).toBe(undefined);
    expect(profile("deepseek-v4-pro", "openrouter")).toBe(null);
  });

  it("refreshes exact current-model catalog metadata snapshots written by prior releases", () => {
    const providerConfig = configWithModels(
      model("deepseek-v4-flash", {
        cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
      }),
      model("deepseek-v4-pro", {
        cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
      }),
    );

    const result = normalizeConfig({ provider: "deepseek", providerConfig });

    expect(result.models).toEqual([
      model("deepseek-v4-flash", {
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      }),
      model("deepseek-v4-pro", {
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
      }),
    ]);
  });

  it("leaves zero-cost retired alias snapshots unchanged when uncataloged", () => {
    const providerConfig = configWithModels(
      model("deepseek-chat", {
        reasoning: false,
        contextWindow: 131_072,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      model("deepseek-reasoner", {
        contextWindow: 131_072,
        maxTokens: 65_536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    );

    expect(normalizeConfig({ provider: "deepseek", providerConfig })).toBe(providerConfig);
  });

  it("preserves tiered pricing layered onto an older flat catalog snapshot", () => {
    const userCost = {
      input: 1.74,
      output: 3.48,
      cacheRead: 0.145,
      cacheWrite: 0,
      tieredPricing: [{ upTo: 200_000, input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }],
    };
    const providerConfig = configWithModels({
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      reasoning: true,
      input: ["text"],
      cost: userCost,
    } as never);

    expect(requireModel(normalizeConfig({ provider: "deepseek", providerConfig }), 0).cost).toBe(
      userCost,
    );
  });

  it("returns providerConfig unchanged when models array is empty", () => {
    const providerConfig = configWithModels();

    expect(normalizeConfig({ provider: "deepseek", providerConfig })).toBe(providerConfig);
  });

  it("hydrates only the models that need it in a mixed list", () => {
    const authored = model("deepseek-v4-flash", {
      cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
      contextWindow: 500_000,
      maxTokens: 100_000,
    });
    const providerConfig = configWithModels(authored, {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      reasoning: true,
      input: ["text"],
    } as never);

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    expect(result).not.toBe(providerConfig);
    expect(requireModel(result, 0)).toBe(requireModel(providerConfig, 0));
    expect(requireModel(result, 1)).toEqual({
      ...requireModel(providerConfig, 1),
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
    });
  });
});
