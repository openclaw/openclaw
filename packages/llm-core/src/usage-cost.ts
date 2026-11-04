import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ModelCostConfig,
  ModelCostRates,
  PricingTier,
  RawModelCostConfig,
  RawPricingTier,
  Usage,
} from "./types.js";

// Pricing is a model snapshot. Weak keys release the sorted schedule with its owner;
// a config/catalog reload supplies a new schedule rather than mutating active tiers.
const sortedPricingTiers = new WeakMap<RawPricingTier[], PricingTier[]>();

const costBuckets = ["input", "output", "cacheRead", "cacheWrite"] as const;

const nonNegativeFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Preserve partial recorded costs and independently authoritative billed totals. */
export function normalizeUsageCost(value: unknown): Usage["cost"] | undefined {
  const raw = asOptionalRecord(value);
  if (!raw) {
    return undefined;
  }
  const cost: Usage["cost"] = {};
  for (const key of [...costBuckets, "total"] as const) {
    const amount = nonNegativeFinite(raw[key]);
    if (amount !== undefined) {
      cost[key] = amount;
    }
  }
  if (cost.total !== undefined && raw.totalOrigin === "provider-billed") {
    cost.totalOrigin = "provider-billed";
  }
  if (cost.total === undefined) {
    cost.total = completeCostTotal(cost);
    if (cost.total === undefined) {
      delete cost.total;
    }
  }
  return Object.keys(cost).length ? cost : undefined;
}

function completeCostTotal(cost: Usage["cost"]): number | undefined {
  let total = 0;
  for (const key of costBuckets) {
    const amount = cost[key];
    if (amount === undefined) {
      return undefined;
    }
    total += amount;
  }
  return Number.isFinite(total) ? total : undefined;
}

function normalizeTieredPricing(raw: RawPricingTier[] | undefined): PricingTier[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const result: PricingTier[] = [];
  for (const tier of raw) {
    const range = tier.range;
    const start = Array.isArray(range) && typeof range[0] === "number" ? range[0] : Number.NaN;
    if (!Number.isFinite(start)) {
      continue;
    }
    const rawEnd = range.length >= 2 ? range[1] : null;
    const end =
      typeof rawEnd === "number" && Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : Infinity;
    if (
      !Number.isFinite(tier.input) ||
      !Number.isFinite(tier.output) ||
      !Number.isFinite(tier.cacheRead) ||
      !Number.isFinite(tier.cacheWrite)
    ) {
      continue;
    }
    result.push({
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead,
      cacheWrite: tier.cacheWrite,
      range: [start, end],
    });
  }
  return result.length > 0 ? result.toSorted((a, b) => a.range[0] - b.range[0]) : undefined;
}

export function normalizeModelCostConfig(cost: RawModelCostConfig): ModelCostConfig {
  const result: ModelCostConfig = {};
  for (const key of costBuckets) {
    const rate = nonNegativeFinite(cost[key]);
    if (rate !== undefined) {
      result[key] = rate;
    }
  }
  const tiers = normalizeTieredPricing(cost.tieredPricing);
  if (tiers) {
    result.tieredPricing = tiers;
  }
  return result;
}

export function normalizeResolvedPricing(cost: RawModelCostConfig): ModelCostConfig;
export function normalizeResolvedPricing(
  cost: RawModelCostConfig | undefined,
): ModelCostConfig | undefined;
export function normalizeResolvedPricing(
  cost: RawModelCostConfig | undefined,
): ModelCostConfig | undefined {
  return !cost || typeof cost !== "object" || Array.isArray(cost)
    ? undefined
    : normalizeModelCostConfig(cost);
}

function selectPricingRates(cost: RawModelCostConfig, promptTokens: number): ModelCostRates {
  const tiers = cost.tieredPricing;
  if (!tiers?.length) {
    return cost;
  }
  let sorted = sortedPricingTiers.get(tiers);
  if (!sorted) {
    sorted = normalizeTieredPricing(tiers) ?? [];
    sortedPricingTiers.set(tiers, sorted);
  }
  if (promptTokens <= 0) {
    return sorted[0] ?? cost;
  }
  const matched = sorted.find(
    (tier) => promptTokens >= tier.range[0] && promptTokens < tier.range[1],
  );
  // Preserve whole-request pricing for gaps and overflow: nearest lower tier,
  // otherwise the first tier. Never blend the buckets across tiers.
  return matched ?? sorted.findLast((tier) => promptTokens >= tier.range[0]) ?? sorted[0] ?? cost;
}

/** Price only measured quantities or qualified zero rates; never synthesize missing buckets. */
export function calculateUsageCost(
  usage: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">>,
  pricing: RawModelCostConfig | undefined,
): Usage["cost"] {
  const input = nonNegativeFinite(usage.input);
  const cacheRead = nonNegativeFinite(usage.cacheRead);
  const cacheWrite = nonNegativeFinite(usage.cacheWrite);
  const promptTokens =
    input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
      ? input + cacheRead + cacheWrite
      : undefined;
  const rates: ModelCostRates = !pricing
    ? {}
    : pricing.tieredPricing?.length && promptTokens === undefined
      ? {}
      : selectPricingRates(pricing, promptTokens ?? 0);
  const price = (count: number | undefined, rate: number | undefined): number | undefined => {
    const qualifiedRate = nonNegativeFinite(rate);
    if (count === 0 || qualifiedRate === 0) {
      return 0;
    }
    const amount =
      count !== undefined && qualifiedRate !== undefined
        ? (count * qualifiedRate) / 1_000_000
        : undefined;
    return nonNegativeFinite(amount);
  };
  const cost: Usage["cost"] = {};
  for (const key of costBuckets) {
    const amount = price(nonNegativeFinite(usage[key]), rates[key]);
    if (amount !== undefined) {
      cost[key] = amount;
    }
  }
  // An observed one-hour subset needs its own input rate, not a guessed cache-write price.
  const oneHour = nonNegativeFinite(usage.cacheWrite1h);
  if (oneHour !== undefined && oneHour > 0) {
    const boundedOneHour = cacheWrite === undefined ? oneHour : Math.min(cacheWrite, oneHour);
    const shortCost = price(
      cacheWrite === undefined ? undefined : cacheWrite - boundedOneHour,
      rates.cacheWrite,
    );
    const longCost = price(boundedOneHour, rates.input === undefined ? undefined : rates.input * 2);
    if (shortCost === undefined || longCost === undefined) {
      delete cost.cacheWrite;
    } else {
      cost.cacheWrite = shortCost + longCost;
    }
  }
  return normalizeUsageCost(cost) ?? {};
}

/** Provider-reported token counts for one embedding request. */
export type EmbeddingUsage = {
  promptTokens: number;
  totalTokens: number;
};

export function extractEmbeddingUsage(payload: unknown): EmbeddingUsage | undefined {
  const usage = asOptionalRecord(asOptionalRecord(payload)?.usage);
  const promptTokens = normalizeUsageCount(usage?.prompt_tokens);
  const totalTokens = normalizeUsageCount(usage?.total_tokens);
  if (promptTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  // Embeddings bill input tokens only; providers may report just one of these fields.
  return {
    promptTokens: promptTokens ?? totalTokens ?? 0,
    totalTokens: totalTokens ?? promptTokens ?? 0,
  };
}

function normalizeUsageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
