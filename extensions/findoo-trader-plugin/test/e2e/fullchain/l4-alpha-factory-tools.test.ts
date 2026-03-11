/**
 * L4 — Alpha Factory Tools: simulates LLM tool_use sequences for
 * fin_alpha_factory_status and fin_alpha_factory_run.
 *
 * Zero LLM cost — no API key needed.
 *
 * Scenarios:
 *   1. Status returns valid JSON stats (all zeros initially)
 *   2. Status after start shows running=true
 *   3. Run with empty array returns empty results
 *   4. Run with good backtest data → strategies pass
 *   5. Run with bad backtest data (low Sharpe) → strategies fail
 *   6. Multi-step: run screening → check status shows updated counts
 *   7. Run when backtest returns null → all fail with reason
 *   8. Stats accumulate across multiple runs
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/l4-alpha-factory-tools.test.ts
 */
vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlphaFactoryOrchestrator } from "../../../src/alpha-factory/orchestrator.js";
import { ScreeningPipeline } from "../../../src/alpha-factory/screening-pipeline.js";
import { ActivityLogStore } from "../../../src/core/activity-log-store.js";

// ── Helpers ──

interface BacktestResult {
  strategyId: string;
  sharpe: number;
  maxDrawdown: number;
  totalTrades: number;
}

function makeMockBacktestService(resultMap: Map<string, BacktestResult | null>) {
  return {
    async runBacktest(params: { strategyId: string }): Promise<BacktestResult | null> {
      return resultMap.get(params.strategyId) ?? null;
    },
  };
}

function createAlphaFactoryTools(alphaFactory: AlphaFactoryOrchestrator) {
  return {
    fin_alpha_factory_status: async () => {
      return { text: JSON.stringify(alphaFactory.getStats(), null, 2) };
    },
    fin_alpha_factory_run: async (params: { strategyIds: string[] }) => {
      const result = await alphaFactory.runScreening(params.strategyIds);
      return { text: JSON.stringify(result, null, 2) };
    },
  };
}

// ── Tests ──

describe("L4 — Alpha Factory Tools", () => {
  let tmpDir: string;
  let activityLog: ActivityLogStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "l4-alpha-factory-"));
    activityLog = new ActivityLogStore(join(tmpDir, "activity.db"));
  });

  afterEach(() => {
    activityLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fin_alpha_factory_status returns valid JSON stats (all zeros initially)", async () => {
    const orchestrator = new AlphaFactoryOrchestrator({ activityLog });
    const tools = createAlphaFactoryTools(orchestrator);

    const result = await tools.fin_alpha_factory_status();
    const stats = JSON.parse(result.text);

    expect(stats.running).toBe(false);
    expect(stats.ideationCount).toBe(0);
    expect(stats.screeningPassed).toBe(0);
    expect(stats.screeningFailed).toBe(0);
    expect(stats.validationPassed).toBe(0);
    expect(stats.validationFailed).toBe(0);
    expect(stats.gcKilled).toBe(0);
    expect(stats.evolutionCycles).toBe(0);
    expect(stats.lastCycleAt).toBe(0);
  });

  it("fin_alpha_factory_status after start shows running=true", async () => {
    const orchestrator = new AlphaFactoryOrchestrator({ activityLog });
    orchestrator.start();
    const tools = createAlphaFactoryTools(orchestrator);

    const result = await tools.fin_alpha_factory_status();
    const stats = JSON.parse(result.text);

    expect(stats.running).toBe(true);

    orchestrator.stop();
  });

  it("fin_alpha_factory_run with empty array returns empty results", async () => {
    const resultMap = new Map<string, BacktestResult | null>();
    const backtestService = makeMockBacktestService(resultMap);
    const pipeline = new ScreeningPipeline({ backtestService });
    const orchestrator = new AlphaFactoryOrchestrator({
      screeningPipeline: pipeline,
      activityLog,
    });
    const tools = createAlphaFactoryTools(orchestrator);

    const result = await tools.fin_alpha_factory_run({ strategyIds: [] });
    const parsed = JSON.parse(result.text);

    expect(parsed.passed).toEqual([]);
    expect(parsed.failed).toEqual([]);
  });

  it("fin_alpha_factory_run with good backtest data → strategies pass", async () => {
    const resultMap = new Map<string, BacktestResult | null>([
      [
        "strat-good-1",
        {
          strategyId: "strat-good-1",
          sharpe: 1.5,
          maxDrawdown: -10,
          totalTrades: 100,
        },
      ],
      [
        "strat-good-2",
        {
          strategyId: "strat-good-2",
          sharpe: 0.8,
          maxDrawdown: -20,
          totalTrades: 60,
        },
      ],
    ]);
    const backtestService = makeMockBacktestService(resultMap);
    const pipeline = new ScreeningPipeline({ backtestService });
    const orchestrator = new AlphaFactoryOrchestrator({
      screeningPipeline: pipeline,
      activityLog,
    });
    const tools = createAlphaFactoryTools(orchestrator);

    const result = await tools.fin_alpha_factory_run({
      strategyIds: ["strat-good-1", "strat-good-2"],
    });
    const parsed = JSON.parse(result.text);

    expect(parsed.passed).toContain("strat-good-1");
    expect(parsed.passed).toContain("strat-good-2");
    expect(parsed.failed).toEqual([]);
  });

  it("fin_alpha_factory_run with bad backtest data (low Sharpe) → strategies fail", async () => {
    const resultMap = new Map<string, BacktestResult | null>([
      [
        "strat-bad-1",
        {
          strategyId: "strat-bad-1",
          sharpe: 0.1,
          maxDrawdown: -5,
          totalTrades: 200,
        },
      ],
      [
        "strat-bad-2",
        {
          strategyId: "strat-bad-2",
          sharpe: 1.0,
          maxDrawdown: -50,
          totalTrades: 80,
        },
      ],
    ]);
    const backtestService = makeMockBacktestService(resultMap);
    const pipeline = new ScreeningPipeline({ backtestService });
    const orchestrator = new AlphaFactoryOrchestrator({
      screeningPipeline: pipeline,
      activityLog,
    });
    const tools = createAlphaFactoryTools(orchestrator);

    const result = await tools.fin_alpha_factory_run({
      strategyIds: ["strat-bad-1", "strat-bad-2"],
    });
    const parsed = JSON.parse(result.text);

    expect(parsed.passed).toEqual([]);
    expect(parsed.failed).toContain("strat-bad-1");
    expect(parsed.failed).toContain("strat-bad-2");
  });

  it("multi-step: run screening → check status shows updated counts", async () => {
    const resultMap = new Map<string, BacktestResult | null>([
      [
        "strat-pass",
        {
          strategyId: "strat-pass",
          sharpe: 1.2,
          maxDrawdown: -15,
          totalTrades: 75,
        },
      ],
      [
        "strat-fail",
        {
          strategyId: "strat-fail",
          sharpe: 0.2,
          maxDrawdown: -40,
          totalTrades: 10,
        },
      ],
    ]);
    const backtestService = makeMockBacktestService(resultMap);
    const pipeline = new ScreeningPipeline({ backtestService });
    const orchestrator = new AlphaFactoryOrchestrator({
      screeningPipeline: pipeline,
      activityLog,
    });
    const tools = createAlphaFactoryTools(orchestrator);

    // Step 1: run screening
    await tools.fin_alpha_factory_run({
      strategyIds: ["strat-pass", "strat-fail"],
    });

    // Step 2: check status
    const statusResult = await tools.fin_alpha_factory_status();
    const stats = JSON.parse(statusResult.text);

    expect(stats.screeningPassed).toBe(1);
    expect(stats.screeningFailed).toBe(1);
    expect(stats.lastCycleAt).toBeGreaterThan(0);
  });

  it("fin_alpha_factory_run when backtest returns null → all fail with reason", async () => {
    const resultMap = new Map<string, BacktestResult | null>([
      ["strat-null-1", null],
      ["strat-null-2", null],
    ]);
    const backtestService = makeMockBacktestService(resultMap);
    const pipeline = new ScreeningPipeline({ backtestService });
    const orchestrator = new AlphaFactoryOrchestrator({
      screeningPipeline: pipeline,
      activityLog,
    });
    const tools = createAlphaFactoryTools(orchestrator);

    const result = await tools.fin_alpha_factory_run({
      strategyIds: ["strat-null-1", "strat-null-2"],
    });
    const parsed = JSON.parse(result.text);

    expect(parsed.passed).toEqual([]);
    expect(parsed.failed).toContain("strat-null-1");
    expect(parsed.failed).toContain("strat-null-2");
  });

  it("stats accumulate across multiple runs", async () => {
    const resultMap = new Map<string, BacktestResult | null>([
      [
        "strat-a",
        {
          strategyId: "strat-a",
          sharpe: 2.0,
          maxDrawdown: -5,
          totalTrades: 150,
        },
      ],
      [
        "strat-b",
        {
          strategyId: "strat-b",
          sharpe: 0.1,
          maxDrawdown: -50,
          totalTrades: 5,
        },
      ],
      [
        "strat-c",
        {
          strategyId: "strat-c",
          sharpe: 0.9,
          maxDrawdown: -20,
          totalTrades: 80,
        },
      ],
    ]);
    const backtestService = makeMockBacktestService(resultMap);
    const pipeline = new ScreeningPipeline({ backtestService });
    const orchestrator = new AlphaFactoryOrchestrator({
      screeningPipeline: pipeline,
      activityLog,
    });
    const tools = createAlphaFactoryTools(orchestrator);

    // Run 1: strat-a (pass) + strat-b (fail)
    await tools.fin_alpha_factory_run({
      strategyIds: ["strat-a", "strat-b"],
    });

    // Run 2: strat-c (pass)
    await tools.fin_alpha_factory_run({
      strategyIds: ["strat-c"],
    });

    const statusResult = await tools.fin_alpha_factory_status();
    const stats = JSON.parse(statusResult.text);

    expect(stats.screeningPassed).toBe(2); // strat-a + strat-c
    expect(stats.screeningFailed).toBe(1); // strat-b
  });
});
