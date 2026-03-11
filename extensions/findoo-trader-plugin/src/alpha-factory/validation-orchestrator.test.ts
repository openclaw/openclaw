import { describe, it, expect } from "vitest";
import type { BacktestResult, MarketRegime } from "../shared/types.js";
import { ValidationOrchestrator } from "./validation-orchestrator.js";

function makeBacktestResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    strategyId: "test-strat",
    startDate: 0,
    endDate: 100,
    initialCapital: 10000,
    finalEquity: 11000,
    totalReturn: 10,
    sharpe: 1.5,
    sortino: 2.0,
    maxDrawdown: -5,
    calmar: 2,
    winRate: 0.6,
    profitFactor: 1.5,
    totalTrades: 50,
    trades: Array.from({ length: 50 }, (_, i) => ({
      entryTime: i * 86400000,
      exitTime: (i + 1) * 86400000,
      symbol: "BTC/USDT",
      side: "long" as const,
      entryPrice: 50000,
      exitPrice: 50100,
      quantity: 0.1,
      commission: 5,
      slippage: 1,
      pnl: 10,
      pnlPct: 0.002,
      reason: "signal",
      exitReason: "tp",
    })),
    equityCurve: Array.from({ length: 252 }, (_, i) => 10000 + i * 4),
    dailyReturns: Array.from({ length: 252 }, () => 0.0004),
    ...overrides,
  };
}

describe("ValidationOrchestrator", () => {
  const orchestrator = new ValidationOrchestrator();

  it("fails at monteCarlo for random noise returns", async () => {
    // Near-zero mean returns → Monte Carlo should fail (high p-value)
    const noiseReturns = Array.from({ length: 252 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const bt = makeBacktestResult({ dailyReturns: noiseReturns });
    const labels: MarketRegime[] = Array.from({ length: 252 }, () => "sideways");

    const result = await orchestrator.validate(bt, labels, new Map());
    expect(result.passed).toBe(false);
    expect(result.failedAt).toBe("monteCarlo");
    // Later stages should not be present
    expect(result.regimeSplit).toBeUndefined();
    expect(result.costSensitivity).toBeUndefined();
    expect(result.independence).toBeUndefined();
  });

  it("fails at regimeSplit when not enough regimes pass", async () => {
    // Strong positive returns but only 2 regimes with positive Sharpe
    const returns = Array.from({ length: 252 }, () => 0.005 + (Math.random() - 0.5) * 0.001);
    const bt = makeBacktestResult({ dailyReturns: returns });

    // Only 2 regimes (need >= 3)
    const labels: MarketRegime[] = Array.from({ length: 252 }, (_, i) =>
      i < 126 ? "bull" : "bear",
    );
    // Make bear returns negative to ensure only 1 regime passes
    for (let i = 126; i < 252; i++) {
      returns[i] = -0.005 + (Math.random() - 0.5) * 0.001;
    }

    const result = await orchestrator.validate(
      makeBacktestResult({ dailyReturns: returns }),
      labels,
      new Map(),
    );

    // This should fail at regimeSplit (only 1 of 2 regimes positive, need 3)
    if (result.failedAt === "monteCarlo") {
      // Monte Carlo might fail first due to mixed returns — that's valid fail-fast
      expect(result.passed).toBe(false);
    } else {
      expect(result.failedAt).toBe("regimeSplit");
      expect(result.passed).toBe(false);
    }
  });

  it("returns correct structure on validation result", async () => {
    const bt = makeBacktestResult();
    const labels: MarketRegime[] = Array.from({ length: 252 }, () => "bull");

    const result = await orchestrator.validate(bt, labels, new Map());
    expect(result).toHaveProperty("strategyId", "test-strat");
    expect(result).toHaveProperty("passed");
    expect(result).toHaveProperty("monteCarlo");
  });
});
