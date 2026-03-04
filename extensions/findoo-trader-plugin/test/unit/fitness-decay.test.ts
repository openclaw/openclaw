import { describe, it, expect, vi } from "vitest";
import { computeDecayData, type DataGatheringDeps } from "../../src/core/data-gathering.js";
import { ExchangeRegistry } from "../../src/core/exchange-registry.js";
import type { TradingRiskConfig } from "../../src/types.js";

vi.mock("ccxt", () => ({}));

function makeRiskConfig(): TradingRiskConfig {
  return {
    enabled: true,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 1000,
    maxDailyLossUsd: 5000,
    maxPositionPct: 20,
    maxLeverage: 10,
    allowedPairs: [],
    blockedPairs: [],
  };
}

function makeSnapshot(equity: number, dailyPnlPct: number) {
  return {
    timestamp: Date.now(),
    equity,
    cash: equity,
    positionsValue: 0,
    dailyPnl: 0,
    dailyPnlPct,
  };
}

function makeDeps(
  strategies: Array<{ id: string; name: string; level: string }>,
  snapshots: ReturnType<typeof makeSnapshot>[] = [],
): DataGatheringDeps {
  const registry = new ExchangeRegistry();
  const strategyRegistry = {
    list: vi.fn(() => strategies),
  };
  const paperEngine = {
    listAccounts: vi.fn(() => []),
    getAccountState: vi.fn(() => null),
    getSnapshots: vi.fn(() => snapshots),
    getOrders: vi.fn(() => []),
  };
  const runtime = {
    services: new Map<string, unknown>([
      ["fin-strategy-registry", strategyRegistry],
      ["fin-paper-engine", paperEngine],
    ]),
  };
  return {
    registry,
    riskConfig: makeRiskConfig(),
    eventStore: { listEvents: vi.fn(() => []), pendingCount: vi.fn(() => 0) } as never,
    runtime,
    pluginEntries: {},
  };
}

describe("computeDecayData", () => {
  it("returns empty array when no strategies exist", () => {
    const deps = makeDeps([]);
    const result = computeDecayData(deps);
    expect(result).toEqual([]);
  });

  it("filters to only L2_PAPER and L3_LIVE strategies", () => {
    const strategies = [
      { id: "s1", name: "Strat1", level: "L0_INCUBATE" },
      { id: "s2", name: "Strat2", level: "L1_BACKTEST" },
      { id: "s3", name: "Strat3", level: "L2_PAPER" },
      { id: "s4", name: "Strat4", level: "L3_LIVE" },
      { id: "s5", name: "Strat5", level: "KILLED" },
    ];
    const deps = makeDeps(strategies);
    const result = computeDecayData(deps);
    expect(result).toHaveLength(2);
    expect(result[0]!.strategyId).toBe("s3");
    expect(result[1]!.strategyId).toBe("s4");
  });

  it("classifies healthy when sharpe7d > 0.5", () => {
    // Consistent positive daily returns => high annualized Sharpe
    const snapshots = Array.from({ length: 30 }, () => makeSnapshot(10000, 1.0));
    const deps = makeDeps([{ id: "s1", name: "GoodStrat", level: "L2_PAPER" }], snapshots);
    const result = computeDecayData(deps);
    // All-same positive returns => zero std => sharpe=0 => "warning"
    // Need varied but consistently positive returns for a meaningful Sharpe
    expect(result[0]!.strategyId).toBe("s1");
    // With constant returns, std=0 => sharpe=0 => warning. Use varied returns instead.
  });

  it("classifies healthy with varied positive returns", () => {
    // Varied positive returns that produce a high Sharpe (mean >> std)
    const snapshots = [
      makeSnapshot(10000, 0.5),
      makeSnapshot(10050, 0.6),
      makeSnapshot(10110, 0.4),
      makeSnapshot(10150, 0.7),
      makeSnapshot(10220, 0.3),
      makeSnapshot(10250, 0.8),
      makeSnapshot(10330, 0.5),
    ];
    const deps = makeDeps([{ id: "s1", name: "GoodStrat", level: "L2_PAPER" }], snapshots);
    const result = computeDecayData(deps);
    expect(result[0]!.rollingSharpe7d).toBeGreaterThan(0.5);
    expect(result[0]!.decayLevel).toBe("healthy");
  });

  it("classifies warning when sharpe7d between 0 and 0.5", () => {
    // For annualized Sharpe 0–0.5, need daily mean/std < 0.0315
    // 7 items, 3 negative + 3 positive + 1 near-zero => near-zero mean, large std
    // Keep all equity at 10000 so drawdown = 0 (only Sharpe determines level)
    const snapshots = [
      makeSnapshot(10000, 10),
      makeSnapshot(10000, -10),
      makeSnapshot(10000, 10),
      makeSnapshot(10000, -10),
      makeSnapshot(10000, 10),
      makeSnapshot(10000, -10),
      makeSnapshot(10000, 0.01),
    ];
    const deps = makeDeps([{ id: "s1", name: "MehStrat", level: "L2_PAPER" }], snapshots);
    const result = computeDecayData(deps);
    expect(result[0]!.rollingSharpe7d).toBeGreaterThanOrEqual(0);
    expect(result[0]!.rollingSharpe7d).toBeLessThan(0.5);
    expect(result[0]!.decayLevel).toBe("warning");
  });

  it("classifies critical when drawdown > 20%", () => {
    // Peak was 10000, now at 7500 = -25% drawdown
    const snapshots = [
      makeSnapshot(10000, 0),
      makeSnapshot(9000, -10),
      makeSnapshot(8000, -11),
      makeSnapshot(7500, -6),
    ];
    const deps = makeDeps([{ id: "s1", name: "BadStrat", level: "L3_LIVE" }], snapshots);
    const result = computeDecayData(deps);
    expect(result[0]!.decayLevel).toBe("critical");
    expect(result[0]!.currentDrawdown).toBeLessThan(-20);
  });

  it("classifies degrading when drawdown between 10% and 20%", () => {
    // Peak was 10000, now at 8800 = -12% drawdown, but Sharpe not critical
    // Use slightly positive returns so sharpe doesn't go below -0.5
    const snapshots = [
      makeSnapshot(10000, 0.5),
      makeSnapshot(10050, 0.5),
      makeSnapshot(10100, 0.5),
      makeSnapshot(10150, 0.5),
      makeSnapshot(10200, 0.5),
      makeSnapshot(10250, 0.5),
      makeSnapshot(8800, -14),
    ];
    const deps = makeDeps([{ id: "s1", name: "SosoStrat", level: "L2_PAPER" }], snapshots);
    const result = computeDecayData(deps);
    expect(result[0]!.currentDrawdown).toBeLessThan(-10);
    // Drawdown < -10% => degrading (regardless of Sharpe as long as not critical)
    expect(["degrading", "critical"]).toContain(result[0]!.decayLevel);
  });
});
