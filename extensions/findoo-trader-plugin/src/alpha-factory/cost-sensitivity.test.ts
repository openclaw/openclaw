import { describe, it, expect } from "vitest";
import type { TradeRecord } from "../shared/types.js";
import { analyzeCostSensitivity } from "./cost-sensitivity.js";

function makeTrade(commission: number, pnl: number): TradeRecord {
  return {
    entryTime: Date.now(),
    exitTime: Date.now() + 86400000,
    symbol: "BTC/USDT",
    side: "long",
    entryPrice: 50000,
    exitPrice: 50000 + pnl,
    quantity: 1,
    commission,
    slippage: 0,
    pnl,
    pnlPct: pnl / 50000,
    reason: "signal",
    exitReason: "tp",
  };
}

describe("analyzeCostSensitivity", () => {
  it("returns results for all 3 multipliers", () => {
    const trades = [makeTrade(10, 100), makeTrade(10, 50), makeTrade(10, -30)];
    const dailyReturns = [0.002, 0.001, -0.0006];
    const result = analyzeCostSensitivity(trades, dailyReturns, 0.001);
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.multiplier)).toEqual([1, 2, 3]);
  });

  it("Sharpe degrades at higher cost multipliers", () => {
    const trades = [makeTrade(10, 100), makeTrade(10, 50), makeTrade(10, -30)];
    const dailyReturns = Array.from(
      { length: 100 },
      (_, i) => 0.002 + (i % 3 === 0 ? -0.001 : 0.0005),
    );
    const result = analyzeCostSensitivity(trades, dailyReturns, 0.001);

    const sharpes = result.results.map((r) => r.sharpe);
    // Each higher multiplier should have equal or lower Sharpe
    expect(sharpes[0]).toBeGreaterThanOrEqual(sharpes[1]);
    expect(sharpes[1]).toBeGreaterThanOrEqual(sharpes[2]);
  });

  it("marks passed=true when sharpeAt3x > 0.5", () => {
    // Very profitable strategy that survives 3x costs
    const trades = [makeTrade(0.1, 1000)];
    const dailyReturns = Array.from({ length: 252 }, () => 0.005 + (Math.random() - 0.5) * 0.002);
    const result = analyzeCostSensitivity(trades, dailyReturns, 0.001);
    expect(result.sharpeAt3x).toBeGreaterThan(0.5);
    expect(result.passed).toBe(true);
  });

  it("handles empty trades gracefully", () => {
    const result = analyzeCostSensitivity([], [0.001, -0.001], 0.001);
    expect(result.results).toHaveLength(3);
  });
});
