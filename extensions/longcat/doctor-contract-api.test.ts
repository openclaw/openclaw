import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

const LEGACY_STOCK_MODEL = {
  id: "LongCat-2.0",
  name: "LongCat 2.0",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  cost: { input: 0.75, output: 2.95, cacheRead: 0.015, cacheWrite: 0.75 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    maxTokensField: "max_tokens",
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "deepseek",
  },
};

function longcatConfig(models: unknown[]): OpenClawConfig {
  return {
    models: {
      providers: {
        longcat: {
          baseUrl: "https://api.longcat.chat/openai",
          api: "openai-completions",
          models,
        },
      },
    },
  } as OpenClawConfig;
}

describe("LongCat doctor contract", () => {
  const { compat: _compat, ...normalizedStockModel } = LEGACY_STOCK_MODEL;
  it.each([
    ["historical compat", LEGACY_STOCK_MODEL],
    ["core Doctor-normalized compat", normalizedStockModel],
  ])("repairs only the stock row with %s", (_label, stockModel) => {
    const customized = [
      { ...stockModel, name: "My LongCat" },
      { ...stockModel, cost: { ...stockModel.cost, cacheWrite: 0.5 } },
      { ...stockModel, compat: { supportsStore: true } },
      { id: "custom-model", name: "Custom" },
    ];
    const config = longcatConfig([structuredClone(stockModel), ...customized]);

    expect(legacyConfigRules[0]?.match?.(config.models?.providers?.longcat?.models)).toBe(true);

    const result = normalizeCompatibilityConfig({ cfg: config });
    expect(result.changes).toEqual([
      "Updated the historical stock LongCat-2.0 cache-write price from $0.75 to $0.",
    ]);
    expect(result.config.models?.providers?.longcat?.models).toEqual([
      {
        ...stockModel,
        cost: { ...stockModel.cost, cacheWrite: 0 },
      },
      ...customized,
    ]);
    expect(config.models?.providers?.longcat?.models?.[0]?.cost.cacheWrite).toBe(0.75);
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });
});
