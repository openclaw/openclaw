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
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const flatCatalogCost = { input: 11, output: 22, cacheRead: 3, cacheWrite: 4 };
const authoredTier = { ...staleCost, range: [0, Infinity] as [number, number] };
export const sourceRow = (id: string, cost?: Partial<ModelDefinitionConfig["cost"]>) => ({
  id,
  ...(cost === undefined ? {} : { cost }),
});

type ConfiguredPricingCase = {
  name: string;
  cost?: Partial<ModelDefinitionConfig["cost"]>;
  expected: ModelDefinitionConfig["cost"];
  missingSource?: boolean;
  sourceModels?: ReturnType<typeof sourceRow>[];
  provider?: string;
  modelId?: string;
  configuredId?: string;
  noSnapshot?: boolean;
};

export const configuredPricingCases: ConfiguredPricingCase[] = [
  { name: "omitted", expected: catalogCost },
  { name: "empty", cost: {}, expected: catalogCost },
  {
    name: "partial",
    cost: { input: 7 },
    expected: { input: 7, output: 22, cacheRead: 3, cacheWrite: 4 },
  },
  { name: "zero", cost: zeroCost, expected: zeroCost },
  { name: "full", cost: staleCost, expected: staleCost },
  {
    name: "empty tiers",
    cost: { tieredPricing: [] },
    expected: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4 },
  },
  {
    name: "authored tiers",
    cost: { tieredPricing: [{ ...staleCost, range: [0] }] },
    expected: { ...catalogCost, tieredPricing: [{ ...staleCost, range: [0, Infinity] }] },
  },
  { name: "missing source row", missingSource: true, expected: staleCost },
  {
    name: "alias before sparse exact row",
    provider: "anthropic",
    modelId: "claude-opus-5",
    sourceModels: [sourceRow("opus", { input: 99, output: 98 }), sourceRow("claude-opus-5")],
    expected: catalogCost,
  },
  {
    name: "alias after sparse exact row",
    provider: "anthropic",
    modelId: "claude-opus-5",
    sourceModels: [sourceRow("claude-opus-5"), sourceRow("opus", { input: 99, output: 98 })],
    expected: catalogCost,
  },
  {
    name: "alias before partial exact row",
    provider: "anthropic",
    modelId: "claude-opus-5",
    sourceModels: [
      sourceRow("opus", { input: 99, output: 98 }),
      sourceRow("claude-opus-5", { input: 7 }),
    ],
    expected: { ...flatCatalogCost, input: 7 },
  },
  {
    name: "alias after partial exact row",
    provider: "anthropic",
    modelId: "claude-opus-5",
    sourceModels: [
      sourceRow("claude-opus-5", { input: 7 }),
      sourceRow("opus", { input: 99, output: 98 }),
    ],
    expected: { ...flatCatalogCost, input: 7 },
  },
  {
    name: "self-prefix before sparse literal row",
    provider: "custom",
    sourceModels: [sourceRow("custom/priced-model", { input: 88 }), sourceRow("priced-model")],
    expected: catalogCost,
  },
  {
    name: "self-prefix after sparse literal row",
    provider: "custom",
    sourceModels: [sourceRow("priced-model"), sourceRow("custom/priced-model", { output: 87 })],
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
    name: "selected legacy-prefixed row without an exact sibling",
    provider: "custom",
    configuredId: "custom/priced-model",
    sourceModels: [sourceRow("custom/priced-model", { input: 7 })],
    expected: { ...flatCatalogCost, input: 7 },
  },
  {
    name: "same-spelling partial costs",
    sourceModels: [
      sourceRow("priced-model", { input: 7 }),
      sourceRow(" priced-model ", { output: 8, cacheRead: 0 }),
      sourceRow("priced-model", { input: 99, cacheWrite: 2 }),
    ],
    expected: { input: 7, output: 8, cacheRead: 0, cacheWrite: 2 },
  },
  {
    name: "same-spelling explicit zero cost",
    sourceModels: [sourceRow("priced-model", zeroCost), sourceRow("priced-model", { input: 99 })],
    expected: zeroCost,
  },
  {
    name: "same-spelling flat price before tiers",
    sourceModels: [
      sourceRow("priced-model", { input: 7 }),
      sourceRow("priced-model", { tieredPricing: [authoredTier] }),
    ],
    expected: { ...flatCatalogCost, input: 7 },
  },
  {
    name: "same-spelling authored tiers",
    sourceModels: [
      sourceRow("priced-model", { tieredPricing: [authoredTier] }),
      sourceRow("priced-model", { input: 7 }),
    ],
    expected: { ...flatCatalogCost, input: 7, tieredPricing: [authoredTier] },
  },
  {
    name: "same-spelling explicit empty tiers",
    sourceModels: [
      sourceRow("priced-model", { tieredPricing: [] }),
      sourceRow("priced-model", { input: 7 }),
    ],
    expected: { ...flatCatalogCost, input: 7 },
  },
  {
    name: "same-spelling empty cost before a partial price",
    sourceModels: [sourceRow("priced-model", {}), sourceRow("priced-model", { output: 8 })],
    expected: { ...flatCatalogCost, output: 8 },
  },
  { name: "independent runtime without source snapshot", noSnapshot: true, expected: staleCost },
];
