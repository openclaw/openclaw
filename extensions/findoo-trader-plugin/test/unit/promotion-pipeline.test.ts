import { describe, expect, it, vi } from "vitest";
import { PromotionPipeline } from "../../src/fund/promotion-pipeline.js";
import type { StrategyProfile } from "../../src/fund/types.js";
import type { BacktestResult, WalkForwardResult } from "../../src/shared/types.js";

vi.mock("ccxt", () => ({}));

function makeProfile(
  overrides: Partial<StrategyProfile> & { id: string; level: StrategyProfile["level"] },
): StrategyProfile {
  return {
    name: overrides.id,
    fitness: 1.0,
    ...overrides,
  };
}

const goodBacktest: BacktestResult = {
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

const goodWalkForward: WalkForwardResult = {
  passed: true,
  windows: [],
  combinedTestSharpe: 1.2,
  avgTrainSharpe: 1.5,
  ratio: 0.8,
  threshold: 0.6,
};

describe("PromotionPipeline", () => {
  const pipeline = new PromotionPipeline();

  describe("L0 → L1", () => {
    it("auto-promotes from L0 to L1", () => {
      const profile = makeProfile({ id: "s1", level: "L0_INCUBATE" });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(true);
      expect(check.targetLevel).toBe("L1_BACKTEST");
      expect(check.blockers).toHaveLength(0);
    });
  });

  describe("L1 → L2", () => {
    it("promotes when all criteria met", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L1_BACKTEST",
        backtest: goodBacktest,
        walkForward: goodWalkForward,
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(true);
      expect(check.targetLevel).toBe("L2_PAPER");
      expect(check.blockers).toHaveLength(0);
      expect(check.reasons.length).toBeGreaterThan(0);
    });

    it("blocks when walk-forward not passed", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L1_BACKTEST",
        backtest: goodBacktest,
        walkForward: { ...goodWalkForward, passed: false, ratio: 0.3 },
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("Walk-forward failed"))).toBe(true);
    });

    it("blocks when no walk-forward result", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L1_BACKTEST",
        backtest: goodBacktest,
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("No walk-forward"))).toBe(true);
    });

    it("blocks when Sharpe < 1.0", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L1_BACKTEST",
        backtest: { ...goodBacktest, sharpe: 0.8 },
        walkForward: goodWalkForward,
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("Sharpe") && b.includes("< 1.0"))).toBe(true);
    });

    it("blocks when max drawdown exceeds 25%", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L1_BACKTEST",
        backtest: { ...goodBacktest, maxDrawdown: -30 },
        walkForward: goodWalkForward,
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("MaxDD") && b.includes("25%"))).toBe(true);
    });

    it("blocks when fewer than 100 trades", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L1_BACKTEST",
        backtest: { ...goodBacktest, totalTrades: 50 },
        walkForward: goodWalkForward,
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("trades") && b.includes("100"))).toBe(true);
    });

    it("blocks when no backtest result", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L1_BACKTEST",
        walkForward: goodWalkForward,
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("No backtest"))).toBe(true);
    });
  });

  describe("L2 → L3", () => {
    it("promotes when all paper criteria met", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L2_PAPER",
        backtest: goodBacktest,
        paperDaysActive: 45,
        paperTradeCount: 50,
        paperMetrics: {
          rollingSharpe7d: 1.8,
          rollingSharpe30d: 1.8,
          sharpeMomentum: 0.83,
          consecutiveLossDays: 0,
          currentDrawdown: -5,
          peakEquity: 11000,
          decayLevel: "healthy",
        },
        paperEquity: 10500,
        paperInitialCapital: 10000,
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(true);
      expect(check.targetLevel).toBe("L3_LIVE");
    });

    it("blocks when paper days < 30", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L2_PAPER",
        paperDaysActive: 15,
        paperTradeCount: 50,
        paperMetrics: {
          rollingSharpe7d: 1.0,
          rollingSharpe30d: 1.2,
          sharpeMomentum: 0.83,
          consecutiveLossDays: 0,
          currentDrawdown: -5,
          peakEquity: 11000,
          decayLevel: "healthy",
        },
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("days"))).toBe(true);
    });

    it("blocks when paper trades < 30", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L2_PAPER",
        paperDaysActive: 45,
        paperTradeCount: 10,
        paperMetrics: {
          rollingSharpe7d: 1.0,
          rollingSharpe30d: 1.2,
          sharpeMomentum: 0.83,
          consecutiveLossDays: 0,
          currentDrawdown: -5,
          peakEquity: 11000,
          decayLevel: "healthy",
        },
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("trades"))).toBe(true);
    });

    it("blocks when paper Sharpe < 1.5", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L2_PAPER",
        paperDaysActive: 45,
        paperTradeCount: 50,
        paperMetrics: {
          rollingSharpe7d: 0.8,
          rollingSharpe30d: 1.2,
          sharpeMomentum: 0.67,
          consecutiveLossDays: 0,
          currentDrawdown: -5,
          peakEquity: 11000,
          decayLevel: "healthy",
        },
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("Sharpe") && b.includes("< 1.5"))).toBe(true);
    });

    it("blocks when paper drawdown > 20%", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L2_PAPER",
        paperDaysActive: 45,
        paperTradeCount: 50,
        paperMetrics: {
          rollingSharpe7d: 1.0,
          rollingSharpe30d: 1.2,
          sharpeMomentum: 0.83,
          consecutiveLossDays: 0,
          currentDrawdown: -25,
          peakEquity: 11000,
          decayLevel: "warning",
        },
      });
      const check = pipeline.checkPromotion(profile);

      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("drawdown") && b.includes("20%"))).toBe(true);
    });
  });

  describe("L3 and L2 have no further promotion", () => {
    it("L3 cannot be promoted", () => {
      const profile = makeProfile({ id: "s1", level: "L3_LIVE" });
      const check = pipeline.checkPromotion(profile);
      expect(check.eligible).toBe(false);
    });

    it("KILLED cannot be promoted", () => {
      const profile = makeProfile({ id: "s1", level: "KILLED" });
      const check = pipeline.checkPromotion(profile);
      expect(check.eligible).toBe(false);
    });
  });

  describe("demotion: L3 → L2", () => {
    it("demotes on 3 consecutive loss days", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L3_LIVE",
        paperMetrics: {
          rollingSharpe7d: -0.1,
          rollingSharpe30d: 0.5,
          sharpeMomentum: -0.2,
          consecutiveLossDays: 4,
          currentDrawdown: -10,
          peakEquity: 11000,
          decayLevel: "warning",
        },
      });
      const check = pipeline.checkDemotion(profile);

      expect(check.shouldDemote).toBe(true);
      expect(check.targetLevel).toBe("L2_PAPER");
      expect(check.reasons.some((r) => r.includes("consecutive loss"))).toBe(true);
    });

    it("demotes on 7d Sharpe < 0", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L3_LIVE",
        paperMetrics: {
          rollingSharpe7d: -0.5,
          rollingSharpe30d: 0.3,
          sharpeMomentum: -1.67,
          consecutiveLossDays: 1,
          currentDrawdown: -5,
          peakEquity: 11000,
          decayLevel: "degrading",
        },
      });
      const check = pipeline.checkDemotion(profile);

      expect(check.shouldDemote).toBe(true);
      expect(check.targetLevel).toBe("L2_PAPER");
    });

    it("demotes on critical decay", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L3_LIVE",
        paperMetrics: {
          rollingSharpe7d: 0.1,
          rollingSharpe30d: 0.2,
          sharpeMomentum: 0.5,
          consecutiveLossDays: 2,
          currentDrawdown: -15,
          peakEquity: 12000,
          decayLevel: "critical",
        },
      });
      const check = pipeline.checkDemotion(profile);

      expect(check.shouldDemote).toBe(true);
      expect(check.reasons.some((r) => r.includes("critical"))).toBe(true);
    });

    it("kills on cumulative loss > 40%", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L3_LIVE",
        paperEquity: 5000,
        paperInitialCapital: 10000,
        paperMetrics: {
          rollingSharpe7d: -2,
          rollingSharpe30d: -1,
          sharpeMomentum: 2,
          consecutiveLossDays: 10,
          currentDrawdown: -50,
          peakEquity: 10000,
          decayLevel: "critical",
        },
      });
      const check = pipeline.checkDemotion(profile);

      expect(check.shouldDemote).toBe(true);
      expect(check.targetLevel).toBe("KILLED");
    });

    it("does not demote healthy L3", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L3_LIVE",
        paperMetrics: {
          rollingSharpe7d: 1.0,
          rollingSharpe30d: 1.2,
          sharpeMomentum: 0.83,
          consecutiveLossDays: 0,
          currentDrawdown: -3,
          peakEquity: 11000,
          decayLevel: "healthy",
        },
      });
      const check = pipeline.checkDemotion(profile);

      expect(check.shouldDemote).toBe(false);
    });
  });

  describe("demotion: L2 → L1", () => {
    it("demotes on 30d Sharpe < -0.5", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L2_PAPER",
        paperMetrics: {
          rollingSharpe7d: -1.0,
          rollingSharpe30d: -0.8,
          sharpeMomentum: 1.25,
          consecutiveLossDays: 5,
          currentDrawdown: -20,
          peakEquity: 10000,
          decayLevel: "critical",
        },
      });
      const check = pipeline.checkDemotion(profile);

      expect(check.shouldDemote).toBe(true);
      expect(check.targetLevel).toBe("L1_BACKTEST");
    });

    it("demotes on backtest-paper deviation > 50%", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L2_PAPER",
        backtest: { ...goodBacktest, sharpe: 2.0 },
        paperMetrics: {
          rollingSharpe7d: 0.5,
          rollingSharpe30d: 0.3,
          sharpeMomentum: 1.67,
          consecutiveLossDays: 0,
          currentDrawdown: -5,
          peakEquity: 10500,
          decayLevel: "warning",
        },
      });
      const check = pipeline.checkDemotion(profile);

      expect(check.shouldDemote).toBe(true);
      expect(check.targetLevel).toBe("L1_BACKTEST");
      expect(check.reasons.some((r) => r.includes("deviation"))).toBe(true);
    });

    it("does not demote healthy L2", () => {
      const profile = makeProfile({
        id: "s1",
        level: "L2_PAPER",
        backtest: goodBacktest,
        paperMetrics: {
          rollingSharpe7d: 1.0,
          rollingSharpe30d: 1.0,
          sharpeMomentum: 1.0,
          consecutiveLossDays: 0,
          currentDrawdown: -3,
          peakEquity: 10500,
          decayLevel: "healthy",
        },
      });
      const check = pipeline.checkDemotion(profile);

      expect(check.shouldDemote).toBe(false);
    });
  });

  describe("no demotion for lower levels", () => {
    it("L0 has no demotion", () => {
      const check = pipeline.checkDemotion(makeProfile({ id: "s1", level: "L0_INCUBATE" }));
      expect(check.shouldDemote).toBe(false);
    });

    it("L1 has no demotion", () => {
      const check = pipeline.checkDemotion(makeProfile({ id: "s1", level: "L1_BACKTEST" }));
      expect(check.shouldDemote).toBe(false);
    });
  });
});
