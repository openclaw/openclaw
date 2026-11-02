import type { ModelDefinitionConfig } from "../../config/types.models.js";

export const catalogCost = {
  input: 11,
  output: 22,
  cacheRead: 3,
  cacheWrite: 4,
  tieredPricing: [
    {
      input: 33,
      output: 44,
      cacheRead: 5,
      cacheWrite: 6,
      range: [0, Infinity] as [number, number],
    },
  ],
};
export const staleCost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
export const flatCatalogCost = { input: 11, output: 22, cacheRead: 3, cacheWrite: 4 };
const authoredTier = { ...staleCost, range: [0, Infinity] as [number, number] };
export const sourceRow = (id: string, cost?: Partial<ModelDefinitionConfig["cost"]>) => ({
  id,
  ...(cost === undefined ? {} : { cost }),
});

type ConfiguredPricingCase = {
  name: string;
  expected: ModelDefinitionConfig["cost"];
  sourceModels?: ReturnType<typeof sourceRow>[];
  provider?: string;
  modelId?: string;
};

export const configuredPricingCases: ConfiguredPricingCase[] = [
  { name: "missing source row", expected: staleCost },
  {
    name: "alias before sparse exact row",
    provider: "anthropic",
    modelId: "claude-opus-5-5",
    sourceModels: [sourceRow("opus", { input: 99, output: 98 }), sourceRow("claude-opus-5-5")],
    expected: catalogCost,
  },
  {
    name: "bare row beside a selected literal namespace",
    provider: "custom",
    modelId: "custom/priced-model",
    sourceModels: [sourceRow("priced-model", { input: 88 }), sourceRow("custom/priced-model")],
    expected: catalogCost,
  },
  {
    name: "same-spelling authored tiers",
    sourceModels: [
      sourceRow("priced-model", { tieredPricing: [authoredTier] }),
      sourceRow("priced-model", { input: 7 }),
    ],
    expected: { ...flatCatalogCost, input: 7, tieredPricing: [authoredTier] },
  },
];
