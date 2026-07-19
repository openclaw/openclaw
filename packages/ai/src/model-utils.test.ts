import { describe, expect, it } from "vitest";
import { applyProviderReportedUsageCost, calculateCost } from "./model-utils.js";
import type { Model, Usage } from "./types.js";

function pricedUsage(): Usage {
  const usage: Usage = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const model = {
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  } as Model;
  calculateCost(model, usage);
  return usage;
}

describe("applyProviderReportedUsageCost", () => {
  it("retains the catalog estimate the billed total replaced", () => {
    const usage = pricedUsage();

    applyProviderReportedUsageCost(usage, 0.00042);

    expect(usage.cost.total).toBe(0.00042);
    expect(usage.cost.totalOrigin).toBe("provider-billed");
    expect(usage.cost.estimatedTotal).toBeCloseTo(0.00002, 10);
    const { input, output, cacheRead, cacheWrite } = usage.cost;
    expect(input + output + cacheRead + cacheWrite).toBeCloseTo(0.00002, 10);
  });

  it("keeps the first snapshot when applied more than once", () => {
    const usage = pricedUsage();

    applyProviderReportedUsageCost(usage, 0.00042);
    applyProviderReportedUsageCost(usage, 0.00099);

    // Without the once-only snapshot the second call would store the billed total
    // as the "estimate", making the breakdown appear to reconcile by construction.
    expect(usage.cost.total).toBe(0.00099);
    expect(usage.cost.estimatedTotal).toBeCloseTo(0.00002, 10);
  });

  it("leaves the estimate untouched for an unusable reported cost", () => {
    const usage = pricedUsage();

    applyProviderReportedUsageCost(usage, -1);

    expect(usage.cost.total).toBeCloseTo(0.00002, 10);
    expect(usage.cost.totalOrigin).toBeUndefined();
    expect(usage.cost.estimatedTotal).toBeUndefined();
  });
});
