/** Leaf catalog cost rule shared by the catalog writer and the persisted-catalog repair owner. */
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type ProviderCatalogModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ProviderCatalogModelConfig = NonNullable<
  NonNullable<ProviderCatalogModelsConfig["providers"]>[string]["models"]
>[number];

/** Completes a partial cost with zeroed rates; an absent cost stays absent. */
export function normalizeModelCostForCatalog(
  model: ProviderCatalogModelConfig,
): ProviderCatalogModelConfig {
  const cost = model.cost;
  if (
    !cost ||
    (["input", "output", "cacheRead", "cacheWrite"] as const).every(
      (key) => cost[key] !== undefined,
    )
  ) {
    return model;
  }
  return {
    ...model,
    cost: {
      ...model.cost,
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
    },
  };
}
