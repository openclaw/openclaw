import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { FundManager } from "../../src/fund/fund-manager.js";
import type { FundConfig } from "../../src/fund/types.js";
import type {
  DecayState,
  StrategyRecord,
  BacktestResult,
  WalkForwardResult,
} from "../../src/shared/types.js";

vi.mock("ccxt", () => ({}));

const config: FundConfig = {
  totalCapital: 100000,
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "weekly",
};

const goodBT: BacktestResult = {
  strategyId: "s1",
  startDate: Date.now() - 86_400_000 * 365,
  endDate: Date.now(),
  initialCapital: 10000,
  finalEquity: 18000,
  totalReturn: 80,
  sharpe: 1.8,
  sortino: 2.5,
  maxDrawdown: -12,
  calmar: 6.7,
  winRate: 0.55,
  profitFactor: 1.6,
  totalTrades: 200,
  trades: [],
  equityCurve: [],
  dailyReturns: [],
};

const goodWF: WalkForwardResult = {
  passed: true,
  windows: [],
  combinedTestSharpe: 1.3,
  avgTrainSharpe: 1.7,
  ratio: 0.76,
  threshold: 0.6,
};

function makeRecord(overrides: Partial<StrategyRecord> & { id: string }): StrategyRecord {
  const now = Date.now();
  return {
    name: overrides.id,
    version: "1.0.0",
    level: "L2_PAPER",
    definition: {
      id: overrides.id,
      name: overrides.id,
      version: "1.0.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1d"],
      parameters: {},
      async onBar() {
        return null;
      },
    },
    createdAt: now - 86_400_000 * 90,
    updatedAt: now,
    lastBacktest: goodBT,
    lastWalkForward: goodWF,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fund-mgr-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("FundManager", () => {
  it("initializes with default state", () => {
    const fm = new FundManager(join(tmpDir, "fund.json"), config);
    const state = fm.getState();

    expect(state.totalCapital).toBe(100000);
    expect(state.allocations).toEqual([]);
    expect(state.lastRebalanceAt).toBe(0);
  });

  it("persists and reloads state", () => {
    const path = join(tmpDir, "fund.json");
    const fm1 = new FundManager(path, config);
    fm1.setTotalCapital(200000);

    const fm2 = new FundManager(path, config);
    expect(fm2.getState().totalCapital).toBe(200000);
  });

  it("builds profiles from strategy records", () => {
    const fm = new FundManager(join(tmpDir, "fund.json"), config);
    const records = [
      makeRecord({ id: "s1", level: "L2_PAPER" }),
      makeRecord({ id: "s2", level: "L3_LIVE" }),
      makeRecord({ id: "dead", level: "KILLED" }),
    ];

    const profiles = fm.buildProfiles(records);

    expect(profiles).toHaveLength(2);
    expect(profiles.every((p) => p.fitness !== 0)).toBe(true);
  });

  it("builds profiles with paper data overlay", () => {
    const fm = new FundManager(join(tmpDir, "fund.json"), config);
    const records = [makeRecord({ id: "s1", level: "L2_PAPER" })];

    const paperData = new Map([
      [
        "s1",
        {
          metrics: {
            rollingSharpe7d: 0.8,
            rollingSharpe30d: 1.0,
            sharpeMomentum: 0.8,
            consecutiveLossDays: 0,
            currentDrawdown: -5,
            peakEquity: 10500,
            decayLevel: "healthy" as const,
          } satisfies DecayState,
          equity: 10500,
          initialCapital: 10000,
          daysActive: 45,
          tradeCount: 60,
        },
      ],
    ]);

    const profiles = fm.buildProfiles(records, paperData);

    expect(profiles[0]!.paperMetrics).toBeDefined();
    expect(profiles[0]!.paperEquity).toBe(10500);
    expect(profiles[0]!.paperDaysActive).toBe(45);
    expect(profiles[0]!.paperTradeCount).toBe(60);
  });

  it("allocates capital to eligible strategies", () => {
    const fm = new FundManager(join(tmpDir, "fund.json"), config);
    const records = [
      makeRecord({ id: "s1", level: "L2_PAPER" }),
      makeRecord({ id: "s2", level: "L3_LIVE" }),
    ];

    const profiles = fm.buildProfiles(records);
    const allocations = fm.allocate(profiles);

    expect(allocations.length).toBeGreaterThan(0);
    const total = allocations.reduce((s, a) => s + a.capitalUsd, 0);
    expect(total).toBeLessThanOrEqual(70000 + 1);
    expect(total).toBeGreaterThan(0);

    expect(fm.getState().allocations.length).toBeGreaterThan(0);
    expect(fm.getState().lastRebalanceAt).toBeGreaterThan(0);
  });

  it("generates leaderboard", () => {
    const fm = new FundManager(join(tmpDir, "fund.json"), config);
    const records = [
      makeRecord({ id: "s1", level: "L2_PAPER" }),
      makeRecord({ id: "s2", level: "L3_LIVE" }),
      makeRecord({ id: "s3", level: "L1_BACKTEST" }),
    ];

    const profiles = fm.buildProfiles(records);
    const lb = fm.getLeaderboard(profiles);

    expect(lb.length).toBe(3);
    expect(lb[0]!.rank).toBe(1);
    expect(lb[1]!.rank).toBe(2);
    expect(lb[2]!.rank).toBe(3);
    expect(lb.find((e) => e.strategyId === "s2")!.confidenceMultiplier).toBe(1.1);
  });

  it("evaluates fund risk", () => {
    const fm = new FundManager(join(tmpDir, "fund.json"), config);
    fm.markDayStart(100000);

    const risk = fm.evaluateRisk(95000);
    expect(risk.riskLevel).toBe("caution");
    expect(risk.todayPnl).toBe(-5000);
  });

  it("checks promotion eligibility", () => {
    const fm = new FundManager(join(tmpDir, "fund.json"), config);
    const record = makeRecord({
      id: "s1",
      level: "L1_BACKTEST",
      lastBacktest: goodBT,
      lastWalkForward: goodWF,
    });

    const profiles = fm.buildProfiles([record]);
    const check = fm.checkPromotion(profiles[0]!);

    expect(check.eligible).toBe(true);
    expect(check.targetLevel).toBe("L2_PAPER");
  });

  it("checks demotion for unhealthy strategies", () => {
    const fm = new FundManager(join(tmpDir, "fund.json"), config);
    const record = makeRecord({ id: "s1", level: "L3_LIVE" });

    const paperData = new Map([
      [
        "s1",
        {
          metrics: {
            rollingSharpe7d: -1.0,
            rollingSharpe30d: 0.2,
            sharpeMomentum: -5,
            consecutiveLossDays: 5,
            currentDrawdown: -20,
            peakEquity: 12000,
            decayLevel: "critical" as const,
          } satisfies DecayState,
          equity: 9600,
          initialCapital: 12000,
          daysActive: 60,
          tradeCount: 80,
        },
      ],
    ]);

    const profiles = fm.buildProfiles([record], paperData);
    const check = fm.checkDemotion(profiles[0]!);

    expect(check.shouldDemote).toBe(true);
  });

  describe("rebalance (full cycle)", () => {
    it("runs end-to-end rebalance", () => {
      const fm = new FundManager(join(tmpDir, "fund.json"), config);
      fm.markDayStart(100000);

      const records = [
        makeRecord({ id: "s1", level: "L2_PAPER" }),
        makeRecord({ id: "s2", level: "L3_LIVE" }),
        makeRecord({ id: "s3", level: "L0_INCUBATE" }),
      ];

      const result = fm.rebalance(records);

      expect(result.allocations.length).toBeGreaterThan(0);
      expect(result.leaderboard.length).toBe(2);
      expect(result.risk.riskLevel).toBeDefined();

      const l0Promo = result.promotions.find((p) => p.strategyId === "s3");
      expect(l0Promo).toBeDefined();
      expect(l0Promo!.targetLevel).toBe("L1_BACKTEST");
    });

    it("detects demotions during rebalance", () => {
      const fm = new FundManager(join(tmpDir, "fund.json"), config);
      fm.markDayStart(100000);

      const records = [makeRecord({ id: "unhealthy", level: "L3_LIVE" })];

      const paperData = new Map([
        [
          "unhealthy",
          {
            metrics: {
              rollingSharpe7d: -2.0,
              rollingSharpe30d: -1.0,
              sharpeMomentum: 2.0,
              consecutiveLossDays: 7,
              currentDrawdown: -30,
              peakEquity: 14000,
              decayLevel: "critical" as const,
            } satisfies DecayState,
            equity: 5500,
            initialCapital: 10000,
            daysActive: 90,
            tradeCount: 100,
          },
        ],
      ]);

      const result = fm.rebalance(records, paperData);

      expect(result.demotions.length).toBeGreaterThan(0);
      expect(result.demotions[0]!.strategyId).toBe("unhealthy");
      expect(result.demotions[0]!.shouldDemote).toBe(true);
    });

    it("incorporates correlation data in rebalance", () => {
      const fm = new FundManager(join(tmpDir, "fund.json"), config);
      fm.markDayStart(100000);

      const records = [
        makeRecord({ id: "s1", level: "L3_LIVE" }),
        makeRecord({ id: "s2", level: "L3_LIVE" }),
      ];

      const equityCurves = new Map<string, number[]>();
      equityCurves.set("s1", [0.01, 0.02, -0.01, 0.03, -0.02, 0.01, 0.02]);
      equityCurves.set("s2", [0.01, 0.02, -0.01, 0.03, -0.02, 0.01, 0.02]);

      const result = fm.rebalance(records, undefined, equityCurves);

      const totalAlloc = result.allocations.reduce((s, a) => s + a.capitalUsd, 0);
      expect(totalAlloc).toBeLessThanOrEqual(70000 + 1);
    });
  });

  it("computes correlations", () => {
    const fm = new FundManager(join(tmpDir, "fund.json"), config);
    const curves = new Map<string, number[]>();
    curves.set("s1", [0.01, 0.02, -0.01, 0.03, 0.01]);
    curves.set("s2", [0.01, 0.02, -0.01, 0.03, 0.01]);

    const { matrix, highCorrelation } = fm.computeCorrelations(curves);

    expect(matrix.get("s1")!.get("s2")).toBeCloseTo(1.0, 3);
    expect(highCorrelation.length).toBe(1);
  });
});
