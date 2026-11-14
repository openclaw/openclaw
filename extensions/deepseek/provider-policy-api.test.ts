import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

const cost = (input: number, output: number, cacheRead: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
});

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
    cost: cost(0.14, 0.28, 0.0028),
    ...overrides,
  };
}

describe("deepseek provider-policy-api", () => {
  it.each([
    ["deepseek-v4-flash", cost(0.14, 0.28, 0.028), cost(0.3, 1.2, 0.006)],
    ["deepseek-v4-flash", cost(0.14, 0.28, 0.0028), cost(0.3, 1.2, 0.006)],
    ["deepseek-v4-pro", cost(1.74, 3.48, 0.145), cost(1.32, 3.96, 0.044)],
    ["deepseek-v4-pro", cost(0.435, 0.87, 0.003625), cost(1.32, 3.96, 0.044)],
    ["deepseek-v4-flash-vision-exp", cost(0.44, 1.32, 0.014), cost(0.3, 1.2, 0.006)],
  ])("refreshes the exact previous %s pricing snapshot", (id, previous, current) => {
    const providerConfig = configWithModels(model(id, { cost: previous }));
    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    expect(result.models).toEqual([model(id, { cost: current })]);
    expect(normalizeConfig({ provider: "deepseek", providerConfig: result })).toBe(result);
  });

  it.each([{ contextWindow: 500_000 }, { maxTokens: 100_000 }, { cost: cost(0.435, 0.87, 0.1) }])(
    "preserves a partial previous snapshot with authored overrides: %j",
    (overrides) => {
      const providerConfig = configWithModels(
        model("deepseek-v4-pro", { cost: cost(0.435, 0.87, 0.003625), ...overrides }),
      );
      expect(normalizeConfig({ provider: "deepseek", providerConfig })).toBe(providerConfig);
    },
  );

  it("leaves zero-cost retired alias snapshots unchanged when uncataloged", () => {
    const providerConfig = configWithModels(
      ...["deepseek-chat", "deepseek-reasoner"].map((id) => model(id, { cost: cost(0, 0, 0) })),
    );

    expect(normalizeConfig({ provider: "deepseek", providerConfig })).toBe(providerConfig);
  });

  it("preserves tiered pricing layered onto an older flat catalog snapshot", () => {
    const userCost = {
      ...cost(1.74, 3.48, 0.145),
      tieredPricing: [{ range: [0, 200_000], ...cost(1, 2, 0.1) }],
    } satisfies NonNullable<ModelProviderConfig["models"][number]["cost"]>;
    const providerConfig = configWithModels(model("deepseek-v4-pro", { cost: userCost }));

    expect(normalizeConfig({ provider: "deepseek", providerConfig }).models[0]?.cost).toBe(
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
    expect(result.models[0]).toBe(authored);
    expect(result.models[1]).toEqual({
      ...providerConfig.models[1],
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
    });
  });
});
