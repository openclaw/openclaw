import { describe, expect, it, vi } from "vitest";
import { Leaderboard } from "../../src/fund/leaderboard.js";
import type { StrategyProfile } from "../../src/fund/types.js";
import type { BacktestResult, WalkForwardResult } from "../../src/shared/types.js";

vi.mock("ccxt", () => ({}));

const bt: BacktestResult = {
  strategyId: "test",
  startDate: 0,
  endDate: 1,
  initialCapital: 10000,
  finalEquity: 15000,
  totalReturn: 50,
  sharpe: 1.5,
  sortino: 2.0,
  maxDrawdown: -15,
  calmar: 3.3,
  winRate: 0.6,
  profitFactor: 1.8,
  totalTrades: 150,
  trades: [],
  equityCurve: [],
  dailyReturns: [],
};

const wfPassed: WalkForwardResult = {
  passed: true,
  windows: [],
  combinedTestSharpe: 1.2,
  avgTrainSharpe: 1.5,
  ratio: 0.8,
  threshold: 0.6,
};

function makeProfile(overrides: Partial<StrategyProfile> & { id: string }): StrategyProfile {
  return {
    name: overrides.id,
    level: "L1_BACKTEST",
    fitness: 1.0,
    ...overrides,
  };
}

describe("Leaderboard", () => {
  const lb = new Leaderboard();

  it("ranks strategies by confidence-adjusted score", () => {
    const strategies: StrategyProfile[] = [
      makeProfile({ id: "L3", level: "L3_LIVE", fitness: 1.0 }),
      makeProfile({ id: "L1", level: "L1_BACKTEST", fitness: 2.0 }),
      makeProfile({ id: "L2", level: "L2_PAPER", fitness: 1.5 }),
    ];
    const result = lb.rank(strategies);

    expect(result[0]!.strategyId).toBe("L2");
    expect(result[1]!.strategyId).toBe("L3");
    expect(result[2]!.strategyId).toBe("L1");
    expect(result[0]!.rank).toBe(1);
    expect(result[1]!.rank).toBe(2);
    expect(result[2]!.rank).toBe(3);
  });

  it("filters out KILLED strategies", () => {
    const strategies: StrategyProfile[] = [
      makeProfile({ id: "alive", level: "L2_PAPER", fitness: 1.0 }),
      makeProfile({ id: "dead", level: "KILLED", fitness: 2.0 }),
    ];
    const result = lb.rank(strategies);

    expect(result).toHaveLength(1);
    expect(result[0]!.strategyId).toBe("alive");
  });

  it("filters out L0 strategies", () => {
    const strategies: StrategyProfile[] = [
      makeProfile({ id: "incubating", level: "L0_INCUBATE", fitness: 1.0 }),
      makeProfile({ id: "tested", level: "L1_BACKTEST", fitness: 0.5 }),
    ];
    const result = lb.rank(strategies);

    expect(result).toHaveLength(1);
    expect(result[0]!.strategyId).toBe("tested");
  });

  it("applies walk-forward verification bonus", () => {
    const withWF = makeProfile({
      id: "verified",
      level: "L2_PAPER",
      fitness: 1.0,
      walkForward: wfPassed,
    });
    const withoutWF = makeProfile({
      id: "unverified",
      level: "L2_PAPER",
      fitness: 1.0,
    });

    const result = lb.rank([withWF, withoutWF]);

    const verified = result.find((e) => e.strategyId === "verified")!;
    const unverified = result.find((e) => e.strategyId === "unverified")!;
    expect(verified.confidenceMultiplier).toBe(0.8);
    expect(unverified.confidenceMultiplier).toBe(0.7);
    expect(verified.leaderboardScore).toBeGreaterThan(unverified.leaderboardScore);
  });

  it("includes backtest metrics in entries", () => {
    const strategies = [
      makeProfile({ id: "s1", level: "L1_BACKTEST", fitness: 1.0, backtest: bt }),
    ];
    const result = lb.rank(strategies);

    expect(result[0]!.sharpe).toBe(1.5);
    expect(result[0]!.maxDrawdown).toBe(-15);
    expect(result[0]!.totalTrades).toBe(150);
  });

  it("returns empty for no strategies", () => {
    expect(lb.rank([])).toHaveLength(0);
  });

  it("confidence multipliers match documentation", () => {
    const l1 = makeProfile({ id: "l1", level: "L1_BACKTEST", fitness: 1.0 });
    const l2 = makeProfile({ id: "l2", level: "L2_PAPER", fitness: 1.0 });
    const l3 = makeProfile({ id: "l3", level: "L3_LIVE", fitness: 1.0 });
    const l2wf = makeProfile({
      id: "l2wf",
      level: "L2_PAPER",
      fitness: 1.0,
      walkForward: wfPassed,
    });

    const result = lb.rank([l1, l2, l3, l2wf]);
    const find = (id: string) => result.find((e) => e.strategyId === id)!;

    expect(find("l1").confidenceMultiplier).toBe(0.3);
    expect(find("l2").confidenceMultiplier).toBe(0.7);
    expect(find("l3").confidenceMultiplier).toBe(1.0);
    expect(find("l2wf").confidenceMultiplier).toBe(0.8);
  });
});
