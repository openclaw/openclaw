/** Leaf catalog cost rule shared by the catalog writer and the persisted-catalog repair owner. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Completes numeric partial costs; absent or malformed pricing stays unchanged. */
export function normalizeModelCostForCatalog<T extends object>(model: T): T {
  const cost = "cost" in model ? model.cost : undefined;
  if (
    !isRecord(cost) ||
    COST_FIELDS.every((key) => cost[key] !== undefined) ||
    COST_FIELDS.some((key) => {
      const value = cost[key];
      return value !== undefined && (typeof value !== "number" || !Number.isFinite(value));
    })
  ) {
    return model;
  }
  return {
    ...model,
    cost: {
      ...cost,
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
    },
  };
}
