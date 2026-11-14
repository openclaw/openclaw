import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { DEEPSEEK_MODEL_CATALOG } from "./models.js";

// Onboarding wrote these prices with the 1M/384K limits into user config.
// Refresh only exact snapshots; authored limits and prices remain overrides.
const PREVIOUS_BUNDLED_COSTS: Record<string, ModelDefinitionConfig["cost"][]> = {
  "deepseek-v4-flash": [
    { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
    { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  ],
  "deepseek-v4-pro": [
    { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
    { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
  ],
  "deepseek-v4-flash-vision-exp": [{ input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 }],
};

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasCostValues(cost: unknown): cost is ModelDefinitionConfig["cost"] {
  if (!cost || typeof cost !== "object") {
    return false;
  }
  const c = cost as Record<string, unknown>;
  return (
    typeof c.input === "number" ||
    typeof c.output === "number" ||
    typeof c.cacheRead === "number" ||
    typeof c.cacheWrite === "number"
  );
}

function hasSameCost(left: unknown, right: ModelDefinitionConfig["cost"] | undefined): boolean {
  if (!left || typeof left !== "object" || !right) {
    return false;
  }
  const cost = left as Record<string, unknown>;
  if (Object.hasOwn(cost, "tieredPricing")) {
    return false;
  }
  return (
    cost.input === right.input &&
    cost.output === right.output &&
    cost.cacheRead === right.cacheRead &&
    cost.cacheWrite === right.cacheWrite
  );
}

function isPreviousBundledMetadataSnapshot(raw: ModelDefinitionConfig): boolean {
  return (
    raw.contextWindow === 1_000_000 &&
    raw.maxTokens === 384_000 &&
    (PREVIOUS_BUNDLED_COSTS[raw.id]?.some((cost) => hasSameCost(raw.cost, cost)) ?? false)
  );
}

/**
 * Provider policy surface for DeepSeek.
 *
 * Hydrates missing `contextWindow`, `cost`, and `maxTokens` from the bundled
 * catalog for matching model ids. Explicit user overrides are preserved.
 */
export function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  const { providerConfig } = params;
  if (!Array.isArray(providerConfig.models) || providerConfig.models.length === 0) {
    return providerConfig;
  }

  const catalog = new Map(DEEPSEEK_MODEL_CATALOG.map((model) => [model.id, model]));
  let mutated = false;

  const nextModels = providerConfig.models.map((model) => {
    const catalogEntry = catalog.get(model.id);
    if (!catalogEntry) {
      return model;
    }
    const hasPreviousBundledMetadata = isPreviousBundledMetadataSnapshot(model);
    const patched: Partial<ModelDefinitionConfig> = {};

    // Refresh only whole snapshots written by prior releases. A partial match can
    // be an intentional user cap, so per-field refresh would silently erase it.
    for (const key of ["contextWindow", "maxTokens"] as const) {
      if (
        (!isPositiveNumber(model[key]) ||
          (hasPreviousBundledMetadata && model[key] !== catalogEntry[key])) &&
        isPositiveNumber(catalogEntry[key])
      ) {
        patched[key] = catalogEntry[key];
      }
    }

    if (
      (!hasCostValues(model.cost) || hasPreviousBundledMetadata) &&
      hasCostValues(catalogEntry.cost) &&
      !hasSameCost(model.cost, catalogEntry.cost)
    ) {
      patched.cost = catalogEntry.cost;
    }

    if (Object.keys(patched).length === 0) {
      return model;
    }

    mutated = true;
    return { ...model, ...patched };
  });

  if (!mutated) {
    return providerConfig;
  }

  return { ...providerConfig, models: nextModels };
}
