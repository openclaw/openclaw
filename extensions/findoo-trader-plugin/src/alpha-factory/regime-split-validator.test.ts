import { describe, it, expect } from "vitest";
import type { MarketRegime } from "../shared/types.js";
import { RegimeSplitValidator } from "./regime-split-validator.js";

function makeReturns(mean: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => mean + (i % 2 === 0 ? 0.001 : -0.001));
}

describe("RegimeSplitValidator", () => {
  const validator = new RegimeSplitValidator();

  it("passes when >= 3 regimes have positive Sharpe", async () => {
    // 5 regimes, each with 15 returns; 4 positive, 1 negative
    const returns: number[] = [];
    const labels: MarketRegime[] = [];
    const regimes: MarketRegime[] = ["bull", "bear", "sideways", "volatile", "crisis"];
    const means = [0.005, 0.003, 0.002, 0.001, -0.01]; // 4 positive, 1 negative

    for (let r = 0; r < 5; r++) {
      const chunk = makeReturns(means[r], 15);
      returns.push(...chunk);
      labels.push(...Array.from({ length: 15 }, () => regimes[r]));
    }

    const result = await validator.validate(returns, labels);
    expect(result.passed).toBe(true);
    expect(result.passedRegimes).toBeGreaterThanOrEqual(3);
    expect(result.totalRegimes).toBe(5);
  });

  it("fails when < 3 regimes have positive Sharpe", async () => {
    // 5 regimes, only 2 positive
    const returns: number[] = [];
    const labels: MarketRegime[] = [];
    const regimes: MarketRegime[] = ["bull", "bear", "sideways", "volatile", "crisis"];
    const means = [0.005, 0.003, -0.005, -0.004, -0.01]; // 2 positive, 3 negative

    for (let r = 0; r < 5; r++) {
      const chunk = makeReturns(means[r], 15);
      returns.push(...chunk);
      labels.push(...Array.from({ length: 15 }, () => regimes[r]));
    }

    const result = await validator.validate(returns, labels);
    expect(result.passed).toBe(false);
    expect(result.passedRegimes).toBeLessThan(3);
  });

  it("skips regimes with fewer than 10 data points", async () => {
    const returns = makeReturns(0.005, 12);
    const labels: MarketRegime[] = [
      ...Array.from({ length: 5 }, (): MarketRegime => "bull"),
      ...Array.from({ length: 7 }, (): MarketRegime => "bear"),
    ];
    const result = await validator.validate(returns, labels);
    // bull has 5 (skipped), bear has 7 (skipped) — no regimes qualify
    expect(result.totalRegimes).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("returns regime-level detail in results", async () => {
    const returns = makeReturns(0.003, 20);
    const labels: MarketRegime[] = Array.from({ length: 20 }, () => "bull");
    const result = await validator.validate(returns, labels);
    expect(result.regimeResults).toHaveLength(1);
    expect(result.regimeResults[0].regime).toBe("bull");
    expect(result.regimeResults[0].trades).toBe(20);
  });
});
