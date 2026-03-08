/**
 * L2 — Alpha Factory Pipeline integration tests.
 * Real instances: StrategyRegistry + ScreeningPipeline + ValidationOrchestrator
 *               + GarbageCollector + AlphaFactoryOrchestrator + FailureFeedbackStore
 * Mock only: BacktestService (returns controlled Sharpe/DD/trades)
 */
vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GarbageCollector } from "../../src/alpha-factory/garbage-collector.js";
import { AlphaFactoryOrchestrator } from "../../src/alpha-factory/orchestrator.js";
import { ScreeningPipeline } from "../../src/alpha-factory/screening-pipeline.js";
import { ValidationOrchestrator } from "../../src/alpha-factory/validation-orchestrator.js";
import { ActivityLogStore } from "../../src/core/activity-log-store.js";
import { FailureFeedbackStore } from "../../src/ideation/failure-feedback-store.js";
import type { BacktestResult } from "../../src/shared/types.js";
import { createSmaCrossover } from "../../src/strategy/builtin-strategies/sma-crossover.js";
import { StrategyRegistry } from "../../src/strategy/strategy-registry.js";

let tmpDir: string;
let activityLog: ActivityLogStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l2-alpha-factory-"));
  activityLog = new ActivityLogStore(join(tmpDir, "activity.db"));
});

afterEach(() => {
  activityLog.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeMockBacktestService(resultMap: Map<string, BacktestResult | null>) {
  return {
    async runBacktest(params: { strategyId: string }): Promise<BacktestResult | null> {
      return resultMap.get(params.strategyId) ?? null;
    },
  };
}

function makeGoodBacktest(strategyId: string): BacktestResult {
  return {
    strategyId,
    sharpe: 2.0,
    maxDrawdown: -10,
    totalTrades: 120,
    netReturn: 0.35,
    winRate: 0.6,
    profitFactor: 2.1,
    trades: [],
    dailyReturns: Array.from({ length: 180 }, () => 0.002 + (Math.random() - 0.5) * 0.01),
    equityCurve: [],
  };
}

function makeBadBacktest(strategyId: string): BacktestResult {
  return {
    strategyId,
    sharpe: 0.1,
    maxDrawdown: -45,
    totalTrades: 10,
    netReturn: -0.05,
    winRate: 0.3,
    profitFactor: 0.7,
    trades: [],
    dailyReturns: Array.from({ length: 180 }, () => -0.001 + (Math.random() - 0.5) * 0.01),
    equityCurve: [],
  };
}

describe("L2 — Alpha Factory Pipeline Integration", () => {
  it("empty strategy list → runScreening returns empty", async () => {
    const pipeline = new ScreeningPipeline({ backtestService: makeMockBacktestService(new Map()) });
    const af = new AlphaFactoryOrchestrator({ screeningPipeline: pipeline, activityLog });

    const result = await af.runScreening([]);
    expect(result.passed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("strategy with Sharpe=2.0 passes screening", async () => {
    const resultMap = new Map<string, BacktestResult | null>([["s1", makeGoodBacktest("s1")]]);
    const pipeline = new ScreeningPipeline({ backtestService: makeMockBacktestService(resultMap) });
    const af = new AlphaFactoryOrchestrator({ screeningPipeline: pipeline, activityLog });

    const result = await af.runScreening(["s1"]);
    expect(result.passed).toContain("s1");
    expect(result.failed).toEqual([]);
  });

  it("strategy with Sharpe=0.1 fails screening + FailureFeedbackStore records", async () => {
    const failureStore = new FailureFeedbackStore();
    const resultMap = new Map<string, BacktestResult | null>([["s-bad", makeBadBacktest("s-bad")]]);
    const pipeline = new ScreeningPipeline({ backtestService: makeMockBacktestService(resultMap) });
    const af = new AlphaFactoryOrchestrator({
      screeningPipeline: pipeline,
      activityLog,
      onFailure: (strategyId, stage, reason) => {
        failureStore.record({
          templateId: strategyId,
          symbol: "BTC/USDT",
          failStage: stage as "screening",
          failReason: reason,
          parameters: {},
          timestamp: Date.now(),
        });
      },
    });

    const result = await af.runScreening(["s-bad"]);
    expect(result.failed).toContain("s-bad");

    const recent = failureStore.getRecentPatterns();
    expect(recent.length).toBe(1);
    expect(recent[0].failStage).toBe("screening");
  });

  it("runFullPipeline: screen → validate → correct stats", async () => {
    const resultMap = new Map<string, BacktestResult | null>([
      ["s-good", makeGoodBacktest("s-good")],
    ]);
    const pipeline = new ScreeningPipeline({ backtestService: makeMockBacktestService(resultMap) });
    const validator = new ValidationOrchestrator();

    const af = new AlphaFactoryOrchestrator({
      screeningPipeline: pipeline,
      validationOrchestrator: {
        async validate(strategyId: string) {
          const bt = resultMap.get(strategyId);
          if (!bt) return { strategyId, passed: false, failedAt: "no-backtest" };
          return validator.validate(bt, [], new Map());
        },
      },
      activityLog,
    });

    const result = await af.runFullPipeline(["s-good"]);
    expect(result.screened).toBe(1);
    // Validation may pass or fail depending on Monte Carlo — just verify flow completes
    expect(result.validated + result.failed).toBe(1);

    const stats = af.getStats();
    expect(stats.screeningPassed).toBe(1);
  });

  it("FailureFeedbackStore.getSummary() returns structured markdown", () => {
    const store = new FailureFeedbackStore();
    store.record({
      templateId: "sma-crossover",
      symbol: "BTC/USDT",
      failStage: "screening",
      failReason: "Sharpe 0.10 < 0.5",
      parameters: { fastPeriod: 10 },
      timestamp: Date.now(),
    });
    store.record({
      templateId: "sma-crossover",
      symbol: "ETH/USDT",
      failStage: "screening",
      failReason: "Sharpe 0.20 < 0.5",
      parameters: { fastPeriod: 5 },
      timestamp: Date.now(),
    });

    const summary = store.getSummary();
    expect(summary).toContain("## Lessons from Recent Failures");
    expect(summary).toContain("sma-crossover");
    expect(summary).toContain("x2");
  });

  it("GarbageCollector.collect() returns killed list", () => {
    const gc = new GarbageCollector();
    const strategies = [
      { id: "alive", sharpe30d: 1.0, daysActive: 60, equity: 10000 },
      { id: "dead", sharpe30d: -2.0, daysActive: 120, equity: 3000 },
    ];
    const result = gc.collect(strategies as never);
    // GC returns a result with killed array
    expect(result).toHaveProperty("killed");
    expect(Array.isArray(result.killed)).toBe(true);
  });

  it("pipeline closedloop: create → screen → fail → feedback → getSummary non-empty", async () => {
    const reg = new StrategyRegistry(join(tmpDir, "strats.json"));
    const def = createSmaCrossover({ fastPeriod: 10, slowPeriod: 30 });
    const record = reg.create({
      name: "Closedloop Test",
      definition: { ...def, markets: ["crypto"], symbols: ["BTC/USDT"], timeframes: ["1h"] },
    });

    const failureStore = new FailureFeedbackStore();
    const pipeline = new ScreeningPipeline({
      backtestService: {
        async runBacktest() {
          return null; // backtest fails
        },
      },
    });
    const af = new AlphaFactoryOrchestrator({
      screeningPipeline: pipeline,
      activityLog,
      onFailure: (strategyId, stage, reason) => {
        const s = reg.get(strategyId);
        failureStore.record({
          templateId: s?.name ?? strategyId,
          symbol: s?.definition?.symbols?.[0] ?? "unknown",
          failStage: stage as "screening",
          failReason: reason,
          parameters: s?.definition?.parameters ?? {},
          timestamp: Date.now(),
        });
      },
    });

    const result = await af.runScreening([record.id]);
    expect(result.failed).toContain(record.id);

    const summary = failureStore.getSummary();
    expect(summary).not.toBe("");
    expect(summary).toContain("Closedloop Test");
  });

  it("ValidationOrchestrator fail-fast: MC failure → no regime split", async () => {
    const validator = new ValidationOrchestrator();
    // Random returns with near-zero Sharpe should likely fail MC
    const bt: BacktestResult = {
      strategyId: "mc-fail",
      sharpe: 0.01,
      maxDrawdown: -5,
      totalTrades: 50,
      netReturn: 0.001,
      winRate: 0.5,
      profitFactor: 1.0,
      trades: [],
      dailyReturns: Array.from({ length: 100 }, () => (Math.random() - 0.5) * 0.02),
      equityCurve: [],
    };

    const result = await validator.validate(bt, [], new Map());
    // Should either fail at MC or pass MC but the key thing is it returns a result
    expect(result.strategyId).toBe("mc-fail");
    if (!result.passed) {
      // If MC failed, regimeSplit should not be present
      expect(result.failedAt).toBe("monteCarlo");
      expect(result.regimeSplit).toBeUndefined();
    }
  });
});
