/**
 * Phase F — Scenario S12: Promotion Gate Full Verification.
 *
 * Exercises the PromotionPipeline with boundary-value profiles for every
 * promotion tier (L0→L1, L1→L2, L2→L3) and demotion trigger (L3→L2).
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-promotion-gate-full.test.ts
 */

vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StrategyProfile } from "../../../src/fund/types.js";
import type { BacktestResult, WalkForwardResult, DecayState } from "../../../src/shared/types.js";
import { createFullChainServer, type FullChainContext } from "./harness.js";

// ── Helpers ──

function makeBacktest(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    strategyId: "test-1",
    startDate: 0,
    endDate: 1,
    initialCapital: 10000,
    finalEquity: 12000,
    totalReturn: 20,
    sharpe: 1.5,
    sortino: 2.0,
    maxDrawdown: -15,
    calmar: 1.0,
    winRate: 0.55,
    profitFactor: 1.8,
    totalTrades: 150,
    trades: [],
    equityCurve: [],
    dailyReturns: [],
    ...overrides,
  };
}

function makeWalkForward(overrides: Partial<WalkForwardResult> = {}): WalkForwardResult {
  return {
    passed: true,
    windows: [],
    combinedTestSharpe: 0.8,
    avgTrainSharpe: 1.2,
    ratio: 0.6,
    threshold: 0.5,
    ...overrides,
  };
}

function makeDecayState(overrides: Partial<DecayState> = {}): DecayState {
  return {
    rollingSharpe7d: 1.0,
    rollingSharpe30d: 0.8,
    sharpeMomentum: 0.1,
    consecutiveLossDays: 0,
    currentDrawdown: 5,
    peakEquity: 10000,
    decayLevel: "healthy",
    ...overrides,
  };
}

function makeProfile(overrides: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    id: "test-1",
    name: "Test Strategy",
    level: "L0_INCUBATE",
    fitness: 1.0,
    ...overrides,
  };
}

// ── Test suite ──

describe("S12 — Promotion Gate Full Verification", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 30_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ─── 1. L0→L1: valid definition → eligible ───

  it("L0→L1: valid strategy definition → eligible=true", () => {
    const profile = makeProfile({ level: "L0_INCUBATE" });
    const result = ctx.services.fundManager.promotionPipeline.checkPromotion(profile);

    expect(result.eligible).toBe(true);
    expect(result.targetLevel).toBe("L1_BACKTEST");
    expect(result.blockers).toHaveLength(0);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  // ─── 2. L1→L2: exactly meets all thresholds ───

  it("L1→L2: boundary pass (Sharpe=1.0, DD=-25, trades=100, WF passed)", () => {
    const profile = makeProfile({
      level: "L1_BACKTEST",
      backtest: makeBacktest({
        sharpe: 1.0,
        maxDrawdown: -25,
        totalTrades: 100,
      }),
      walkForward: makeWalkForward({ passed: true, ratio: 0.6, threshold: 0.5 }),
    });
    const result = ctx.services.fundManager.promotionPipeline.checkPromotion(profile);

    expect(result.eligible).toBe(true);
    expect(result.targetLevel).toBe("L2_PAPER");
    expect(result.blockers).toHaveLength(0);
  });

  // ─── 3. L1→L2: Sharpe=0.9 → blocked ───

  it("L1→L2: Sharpe=0.9 → eligible=false, blocker mentions Sharpe", () => {
    const profile = makeProfile({
      level: "L1_BACKTEST",
      backtest: makeBacktest({
        sharpe: 0.9,
        maxDrawdown: -25,
        totalTrades: 100,
      }),
      walkForward: makeWalkForward({ passed: true }),
    });
    const result = ctx.services.fundManager.promotionPipeline.checkPromotion(profile);

    expect(result.eligible).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers.some((b) => /[Ss]harpe/.test(b))).toBe(true);
  });

  // ─── 4. L1→L2: trades=99 → blocked ───

  it("L1→L2: trades=99 → eligible=false, blocker mentions trades", () => {
    const profile = makeProfile({
      level: "L1_BACKTEST",
      backtest: makeBacktest({
        sharpe: 1.5,
        maxDrawdown: -15,
        totalTrades: 99,
      }),
      walkForward: makeWalkForward({ passed: true }),
    });
    const result = ctx.services.fundManager.promotionPipeline.checkPromotion(profile);

    expect(result.eligible).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers.some((b) => /trade/i.test(b))).toBe(true);
  });

  // ─── 5. L2→L3: exactly meets all thresholds ───

  it("L2→L3: boundary pass (30 days, 30 trades, Sharpe=0.5, DD=20, dev~29%)", () => {
    const profile = makeProfile({
      level: "L2_PAPER",
      paperDaysActive: 30,
      paperTradeCount: 30,
      backtest: makeBacktest({ sharpe: 0.7 }),
      paperMetrics: makeDecayState({
        rollingSharpe30d: 0.5,
        currentDrawdown: 20,
      }),
    });
    const result = ctx.services.fundManager.promotionPipeline.checkPromotion(profile);

    // deviation = |0.7 - 0.5| / 0.7 * 100 ≈ 28.6% ≤ 30%
    expect(result.eligible).toBe(true);
    expect(result.targetLevel).toBe("L3_LIVE");
    expect(result.needsUserConfirmation).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  // ─── 6. L2→L3: paperDaysActive=29 → blocked ───

  it("L2→L3: paperDaysActive=29 → eligible=false, blocker mentions days", () => {
    const profile = makeProfile({
      level: "L2_PAPER",
      paperDaysActive: 29,
      paperTradeCount: 30,
      backtest: makeBacktest({ sharpe: 0.7 }),
      paperMetrics: makeDecayState({
        rollingSharpe30d: 0.5,
        currentDrawdown: 20,
      }),
    });
    const result = ctx.services.fundManager.promotionPipeline.checkPromotion(profile);

    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => /day/i.test(b))).toBe(true);
  });

  // ─── 7. L2→L3: BT-Paper deviation=31% → blocked ───

  it("L2→L3: BT-Paper deviation 31% → eligible=false, blocker mentions deviation", () => {
    const profile = makeProfile({
      level: "L2_PAPER",
      paperDaysActive: 30,
      paperTradeCount: 30,
      backtest: makeBacktest({ sharpe: 1.0 }),
      paperMetrics: makeDecayState({
        rollingSharpe30d: 0.69,
        currentDrawdown: 10,
      }),
    });
    const result = ctx.services.fundManager.promotionPipeline.checkPromotion(profile);

    // deviation = |1.0 - 0.69| / 1.0 * 100 = 31% > 30%
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => /deviation/i.test(b))).toBe(true);
  });

  // ─── 8. L3 demotion: 3 consecutive loss days → shouldDemote ───

  it("L3 demotion: consecutiveLossDays=3 → shouldDemote=true, target=L2_PAPER", () => {
    const profile = makeProfile({
      level: "L3_LIVE",
      paperMetrics: makeDecayState({
        consecutiveLossDays: 3,
        rollingSharpe7d: 0.5, // still positive — only loss-days trigger
      }),
    });
    const result = ctx.services.fundManager.promotionPipeline.checkDemotion(profile);

    expect(result.shouldDemote).toBe(true);
    expect(result.targetLevel).toBe("L2_PAPER");
    expect(result.reasons.some((r) => /consecutive/i.test(r))).toBe(true);
  });
});
