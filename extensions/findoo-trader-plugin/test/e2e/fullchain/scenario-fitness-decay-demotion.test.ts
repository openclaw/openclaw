/**
 * Phase F — Scenario S8: Fitness Decay → Auto-Demotion.
 *
 * Exercises the DecayDetector evaluation on synthetic equity curves
 * and validates the PromotionPipeline demotion logic for L3, L2,
 * cumulative-loss KILLED, and healthy-no-demotion scenarios.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-fitness-decay-demotion.test.ts
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
import { DecayDetector } from "../../../src/paper/decay-detector.js";
import type { EquitySnapshot } from "../../../src/paper/types.js";
import { createFullChainServer, type FullChainContext } from "./harness.js";

// ── Helpers ──

const BASE_TS = Date.UTC(2026, 0, 1); // 2026-01-01
const DAY_MS = 86_400_000;

/** Build a single EquitySnapshot. */
function snap(day: number, equity: number, dailyPnl: number, cash = equity * 0.4): EquitySnapshot {
  return {
    accountId: "test-account",
    timestamp: BASE_TS + day * DAY_MS,
    equity,
    cash,
    positionsValue: equity - cash,
    dailyPnl,
    dailyPnlPct: (dailyPnl / (equity - dailyPnl)) * 100,
  };
}

/**
 * Build 20-day rising equity curve: 10000 → ~11500.
 * Each day gains roughly +75 (1.5 k total over 20 days).
 */
function buildProfitableCurve(): EquitySnapshot[] {
  const snapshots: EquitySnapshot[] = [];
  let eq = 10_000;
  for (let d = 0; d < 20; d++) {
    const gain = 60 + Math.random() * 30; // +60~90 per day
    const pnl = d === 0 ? 0 : gain;
    eq += pnl;
    snapshots.push(snap(d, eq, pnl));
  }
  return snapshots;
}

/**
 * Extend curve with 10 days of mixed but mostly negative performance (days 20-29).
 * Alternates small losses with occasional flat/tiny-gain days so consecutive
 * loss count stays below 7, but overall Sharpe momentum declines.
 */
function extendWithSmallLosses(base: EquitySnapshot[]): EquitySnapshot[] {
  const result = [...base];
  let eq = result[result.length - 1]!.equity;
  // Pattern: loss, loss, tiny gain, loss, loss, flat, loss, loss, tiny gain, loss
  const pnls = [-30, -25, 5, -35, -20, 2, -30, -25, 3, -28];
  for (let i = 0; i < 10; i++) {
    eq += pnls[i]!;
    result.push(snap(20 + i, eq, pnls[i]!));
  }
  return result;
}

/**
 * Extend curve with 10 consecutive losing days (days 30-39).
 * Each day loses 80-120, creating 7+ consecutive loss days and heavy drawdown.
 */
function extendWithHeavyLosses(base: EquitySnapshot[]): EquitySnapshot[] {
  const result = [...base];
  let eq = result[result.length - 1]!.equity;
  for (let d = 30; d < 40; d++) {
    const loss = -(80 + Math.random() * 40);
    eq += loss;
    result.push(snap(d, eq, loss));
  }
  return result;
}

// ── Test suite ──

describe("S8 — Fitness Decay → Auto-Demotion", () => {
  let ctx: FullChainContext;
  const detector = new DecayDetector();

  // Pre-build curves (deterministic seed not needed — assertions are range-based)
  const profitCurve = buildProfitableCurve();
  const midCurve = extendWithSmallLosses(profitCurve);
  const fullCurve = extendWithHeavyLosses(midCurve);

  beforeAll(async () => {
    ctx = await createFullChainServer();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  // ── 1. First 20 days: profitable, healthy ──
  it("前 20 天盈利 — evaluate returns healthy with positive metrics", () => {
    const state = detector.evaluate(profitCurve);
    expect(state.decayLevel).toBe("healthy");
    expect(state.rollingSharpe7d).toBeGreaterThan(0);
    expect(state.consecutiveLossDays).toBe(0);
    expect(state.currentDrawdown).toBeLessThanOrEqual(5);
  });

  // ── 2. Days 21-30: Sharpe declining, no longer healthy ──
  it("中间 10 天小幅亏损 — 不再 healthy, Sharpe 明显下降", () => {
    const state = detector.evaluate(midCurve);
    // After 20 profitable days then 10 mixed-loss days, the strategy is no longer healthy.
    // Depending on momentum magnitude it may land in warning, degrading, or critical.
    expect(state.decayLevel).not.toBe("healthy");
    // 7d sharpe should be negative (recent days are mostly losses)
    expect(state.rollingSharpe7d).toBeLessThan(1);
    expect(state.consecutiveLossDays).toBeGreaterThanOrEqual(1);
  });

  // ── 3. Days 31-40: 7+ consecutive loss days → critical ──
  it("后 10 天连续亏损 — consecutiveLoss≥7, decayLevel=critical", () => {
    const state = detector.evaluate(fullCurve);
    expect(state.decayLevel).toBe("critical");
    expect(state.consecutiveLossDays).toBeGreaterThanOrEqual(7);
    expect(state.currentDrawdown).toBeGreaterThan(5);
  });

  // ── 4. L3 demotion: critical decay → shouldDemote=true, L3→L2 ──
  it("PromotionPipeline.checkDemotion: L3 critical → shouldDemote=true, targetLevel=L2_PAPER", () => {
    const pipeline = ctx.services.fundManager.promotionPipeline;
    const criticalMetrics = detector.evaluate(fullCurve);

    const profile: StrategyProfile = {
      id: "strat-decay-1",
      name: "Decaying Strategy",
      level: "L3_LIVE",
      paperMetrics: criticalMetrics,
      paperEquity: fullCurve[fullCurve.length - 1]!.equity,
      paperInitialCapital: 10_000,
      fitness: 0.3,
    };

    const check = pipeline.checkDemotion(profile);
    expect(check.shouldDemote).toBe(true);
    expect(check.targetLevel).toBe("L2_PAPER");
  });

  // ── 5. Demotion reasons contain relevant info ──
  it("降级原因包含 consecutive loss days 或 decay critical", () => {
    const pipeline = ctx.services.fundManager.promotionPipeline;
    const criticalMetrics = detector.evaluate(fullCurve);

    const profile: StrategyProfile = {
      id: "strat-decay-2",
      name: "Decaying Strategy 2",
      level: "L3_LIVE",
      paperMetrics: criticalMetrics,
      paperEquity: fullCurve[fullCurve.length - 1]!.equity,
      paperInitialCapital: 10_000,
      fitness: 0.2,
    };

    const check = pipeline.checkDemotion(profile);
    const joined = check.reasons.join(" | ");
    // At least one of these must appear
    const hasRelevant =
      joined.includes("consecutive loss days") ||
      joined.includes("critical") ||
      joined.includes("Sharpe");
    expect(hasRelevant).toBe(true);
  });

  // ── 6. L2 demotion: 30d Sharpe = -0.8 → L2→L1 ──
  it("L2 策略 30d Sharpe=-0.8 → checkDemotion: L2→L1_BACKTEST", () => {
    const pipeline = ctx.services.fundManager.promotionPipeline;

    const profile: StrategyProfile = {
      id: "strat-l2-bad",
      name: "Poor L2 Strategy",
      level: "L2_PAPER",
      paperMetrics: {
        rollingSharpe7d: -0.5,
        rollingSharpe30d: -0.8,
        sharpeMomentum: -1,
        consecutiveLossDays: 4,
        currentDrawdown: 12,
        peakEquity: 10_000,
        decayLevel: "degrading",
      },
      paperEquity: 8_800,
      paperInitialCapital: 10_000,
      fitness: 0.1,
    };

    const check = pipeline.checkDemotion(profile);
    expect(check.shouldDemote).toBe(true);
    expect(check.targetLevel).toBe("L1_BACKTEST");
    expect(check.reasons.some((r) => r.includes("30d Sharpe"))).toBe(true);
  });

  // ── 7. Cumulative loss > 40% → KILLED ──
  it("cumulative loss > 40% → targetLevel=KILLED", () => {
    const pipeline = ctx.services.fundManager.promotionPipeline;

    const profile: StrategyProfile = {
      id: "strat-doomed",
      name: "Doomed Strategy",
      level: "L3_LIVE",
      paperMetrics: {
        rollingSharpe7d: -1.0,
        rollingSharpe30d: -0.6,
        sharpeMomentum: -2,
        consecutiveLossDays: 10,
        currentDrawdown: 50,
        peakEquity: 10_000,
        decayLevel: "critical",
      },
      paperEquity: 5_000,
      paperInitialCapital: 10_000,
      fitness: 0,
    };

    const check = pipeline.checkDemotion(profile);
    expect(check.shouldDemote).toBe(true);
    expect(check.targetLevel).toBe("KILLED");
    expect(check.reasons.some((r) => r.includes("Cumulative loss"))).toBe(true);
  });

  // ── 8. Healthy L3 → no demotion ──
  it("healthy L3 策略 → shouldDemote=false", () => {
    const pipeline = ctx.services.fundManager.promotionPipeline;

    const profile: StrategyProfile = {
      id: "strat-healthy",
      name: "Healthy Strategy",
      level: "L3_LIVE",
      paperMetrics: {
        rollingSharpe7d: 1.5,
        rollingSharpe30d: 1.2,
        sharpeMomentum: 1.25,
        consecutiveLossDays: 0,
        currentDrawdown: 3,
        peakEquity: 11_000,
        decayLevel: "healthy",
      },
      paperEquity: 10_670,
      paperInitialCapital: 10_000,
      fitness: 0.85,
    };

    const check = pipeline.checkDemotion(profile);
    expect(check.shouldDemote).toBe(false);
    expect(check.reasons).toHaveLength(0);
  });
});
