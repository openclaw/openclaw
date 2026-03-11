/**
 * L4 -- LLM Tool Chain: Strategy Research
 *
 * Simulates multi-step LLM tool_use sequences for strategy research:
 *   1. Create strategy -> backtest -> result with metrics
 *   2. Walk-Forward validation -> test Sharpe >= train Sharpe * 0.6
 *   3. Compare strategies -> side-by-side metric table
 *   4. Deploy to paper trading -> fund allocated
 *   5. Multiple strategy types -> each returns valid definition
 *   6. Custom strategy with rules -> custom rule engine
 *   7. Error: backtest on nonexistent strategy
 *   8. Error: walk-forward on wrong level
 *   9. Full research chain: create -> backtest -> WF -> paper deploy
 *  10. Strategy list with level filter
 *
 * Zero LLM cost -- no API key needed.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/l4-strategy-research-chain.test.ts
 */
vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperEngine } from "../../../src/paper/paper-engine.js";
import { PaperStore } from "../../../src/paper/paper-store.js";
import { registerPaperTools } from "../../../src/paper/tools.js";
import { RemoteBacktestBridge } from "../../../src/strategy/remote-backtest-bridge.js";
import { StrategyRegistry } from "../../../src/strategy/strategy-registry.js";
import { registerStrategyTools } from "../../../src/strategy/tools.js";

// -- Types --

type ToolExecuteFn = (
  id: string,
  params: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: unknown;
}>;

// -- Helpers --

function parseDetails(result: { details: unknown }): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

function captureTools() {
  const tools = new Map<string, ToolExecuteFn>();
  const api = {
    registerTool: vi.fn(
      (def: { name: string; execute: ToolExecuteFn }, opts: { names: string[] }) => {
        for (const name of opts.names) {
          tools.set(name, def.execute.bind(def));
        }
      },
    ),
    runtime: { services: new Map() },
  };
  return { api, tools };
}

function makeMockBacktestService(overrides?: {
  totalReturn?: number;
  sharpe?: number;
  maxDrawdown?: number;
}) {
  const totalReturn = overrides?.totalReturn ?? 15.0;
  const sharpe = overrides?.sharpe ?? 1.3;
  const maxDrawdown = overrides?.maxDrawdown ?? -7.0;

  return {
    async submit() {
      return {
        task: { task_id: "mock-research", status: "completed" },
        report: {
          task_id: "mock-research",
          performance: {
            totalReturn,
            sharpe,
            sortino: 1.6,
            maxDrawdown,
            calmar: 1.0,
            winRate: 58.0,
            profitFactor: 2.0,
            totalTrades: 30,
            finalEquity: 10000 * (1 + totalReturn / 100),
          },
          equity_curve: [
            { date: "2024-01-01", equity: 10000 },
            { date: "2024-06-01", equity: 10000 * (1 + totalReturn / 100) },
          ],
          trade_journal: [],
        },
      };
    },
    toBacktestResult(
      report: Record<string, unknown>,
      meta: { strategyId: string; initialCapital: number },
    ) {
      const p = (report as { performance: Record<string, number> }).performance;
      return {
        strategyId: meta.strategyId,
        startDate: 0,
        endDate: 0,
        initialCapital: meta.initialCapital,
        finalEquity: p.finalEquity ?? meta.initialCapital,
        totalReturn: (p.totalReturn ?? 0) / 100,
        sharpe: p.sharpe ?? 0,
        sortino: p.sortino ?? 0,
        maxDrawdown: (p.maxDrawdown ?? 0) / 100,
        calmar: p.calmar ?? 0,
        winRate: (p.winRate ?? 0) / 100,
        profitFactor: p.profitFactor ?? 0,
        totalTrades: p.totalTrades ?? 0,
        trades: [],
        equityCurve: [meta.initialCapital, p.finalEquity ?? meta.initialCapital],
        dailyReturns: [(p.totalReturn ?? 0) / 100],
      };
    },
    // Walk-forward mock
    async submitWalkForward() {
      return {
        passed: true,
        ratio: 0.85,
        windows: [
          { trainSharpe: 1.5, testSharpe: 1.3, passed: true },
          { trainSharpe: 1.4, testSharpe: 1.1, passed: true },
          { trainSharpe: 1.2, testSharpe: 0.9, passed: true },
          { trainSharpe: 1.3, testSharpe: 0.7, passed: false },
          { trainSharpe: 1.6, testSharpe: 1.4, passed: true },
        ],
      };
    },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l4-research-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================

describe("L4 -- Strategy Research Chain", () => {
  function setup(backtestOverrides?: Parameters<typeof makeMockBacktestService>[0]) {
    const registry = new StrategyRegistry(join(tmpDir, "s.json"));
    const mockService = makeMockBacktestService(backtestOverrides);
    const bridge = new RemoteBacktestBridge(() => mockService as never);
    const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });

    const { api: api1, tools: stratTools } = captureTools();
    registerStrategyTools(api1 as never, registry, bridge, null, paperEngine);

    const { api: api2, tools: paperTools } = captureTools();
    registerPaperTools(api2 as never, paperEngine);

    return { registry, stratTools, paperTools, paperEngine };
  }

  // 1. "Research a BTC trend strategy" -> create -> backtest -> result
  it("1. create + backtest returns complete metrics (totalReturn, sharpe, maxDrawdown, tradeCount)", async () => {
    const { stratTools } = setup();

    // Step 1: Create
    const createResult = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "BTC Trend Follower",
      type: "trend-following-momentum",
      symbols: ["BTC/USDT"],
      timeframes: ["1d"],
    });
    const created = parseDetails(createResult);
    expect(created.created).toBe(true);
    const strategyId = created.id as string;

    // Step 2: Backtest
    const btResult = await stratTools.get("fin_backtest_run")!("conv-1", {
      strategyId,
      capital: 10000,
    });
    const bt = parseDetails(btResult);

    // Verify all required metrics
    expect(typeof bt.totalReturn).toBe("number");
    expect(typeof bt.sharpe).toBe("number");
    expect(typeof bt.maxDrawdown).toBe("number");
    expect(typeof bt.totalTrades).toBe("number");
    expect(bt.totalReturn as number).toBeGreaterThan(0);
    expect(bt.sharpe as number).toBeGreaterThan(0);
    expect(bt.totalTrades as number).toBeGreaterThan(0);

    // Verify formatted output
    const fmt = bt.formatted as Record<string, string>;
    expect(fmt.totalReturn).toContain("%");
    expect(fmt.sharpe).toMatch(/^\d+\.\d+$/);
  });

  // 2. Backtest result retrieval
  it("2. fin_backtest_result retrieves stored result with trade data", async () => {
    const { stratTools } = setup();

    const createResult = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "Result Test",
      type: "sma-crossover",
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;

    // Run backtest first
    await stratTools.get("fin_backtest_run")!("conv-1", { strategyId });

    // Retrieve result
    const resultResult = await stratTools.get("fin_backtest_result")!("conv-1", { strategyId });
    const r = parseDetails(resultResult);
    expect(r.strategyId).toBe(strategyId);
    expect(typeof r.totalReturn).toBe("number");
    expect(typeof r.sharpe).toBe("number");
    expect(typeof r.maxDrawdown).toBe("number");
    expect(typeof r.initialCapital).toBe("number");
    expect(typeof r.finalEquity).toBe("number");
  });

  // 3. Walk-Forward validation
  it("3. walk-forward returns passed/ratio with window details", async () => {
    const { registry, stratTools } = setup();

    // Create, backtest, then manually promote to L1_BACKTEST
    const createResult = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "WF Test",
      type: "sma-crossover",
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;

    // Backtest first
    await stratTools.get("fin_backtest_run")!("conv-1", { strategyId });

    // Promote to L1_BACKTEST (backtest does not auto-promote)
    registry.updateLevel(strategyId, "L1_BACKTEST");

    // Now run walk-forward
    const wfResult = await stratTools.get("fin_walk_forward_run")!("conv-1", {
      strategyId,
      windows: 5,
      threshold: 0.6,
    });
    const wf = parseDetails(wfResult);
    expect(wf).toHaveProperty("passed");
    expect(wf).toHaveProperty("ratio");
    expect(typeof wf.passed).toBe("boolean");
    expect(typeof wf.ratio).toBe("number");
    expect(wf).toHaveProperty("windows");
    expect(Array.isArray(wf.windows)).toBe(true);
  });

  // 4. Compare strategies (via listing two strategies with backtest results)
  it("4. strategy comparison via list shows side-by-side metrics", async () => {
    const { stratTools } = setup();

    // Create SMA strategy
    const s1 = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "SMA Strategy",
      type: "sma-crossover",
    });
    const id1 = (parseDetails(s1) as { id: string }).id;
    await stratTools.get("fin_backtest_run")!("conv-1", { strategyId: id1 });

    // Create RSI strategy
    const s2 = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "RSI Strategy",
      type: "rsi-mean-reversion",
    });
    const id2 = (parseDetails(s2) as { id: string }).id;
    await stratTools.get("fin_backtest_run")!("conv-1", { strategyId: id2 });

    // List all -- LLM would compare side-by-side
    const listResult = await stratTools.get("fin_strategy_list")!("conv-1", {});
    const list = parseDetails(listResult);
    expect(list.total).toBe(2);
    const strategies = list.strategies as Array<{
      name: string;
      lastBacktest: { totalReturn: number; sharpe: number; maxDrawdown: number };
    }>;
    expect(strategies.length).toBe(2);
    // Both have backtest results
    for (const s of strategies) {
      expect(s.lastBacktest).toBeDefined();
      expect(typeof s.lastBacktest.totalReturn).toBe("number");
      expect(typeof s.lastBacktest.sharpe).toBe("number");
    }
  });

  // 5. Multiple strategy types all create successfully
  it("5. all built-in strategy types create successfully", async () => {
    const { stratTools } = setup();

    const types = [
      "sma-crossover",
      "rsi-mean-reversion",
      "bollinger-bands",
      "macd-divergence",
      "trend-following-momentum",
      "volatility-mean-reversion",
      "regime-adaptive",
      "multi-timeframe-confluence",
      "risk-parity-triple-screen",
    ];

    for (const type of types) {
      const result = await stratTools.get("fin_strategy_create")!("conv-1", {
        name: `Test ${type}`,
        type,
      });
      const d = parseDetails(result);
      expect(d.created).toBe(true);
      expect(typeof d.id).toBe("string");
    }
  });

  // 6. Custom strategy with rules
  it("6. custom strategy with buy/sell rules creates successfully", async () => {
    const { stratTools } = setup();

    const result = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "Custom RSI+SMA",
      type: "custom",
      rules: {
        buy: "rsi < 30 AND close > sma",
        sell: "rsi > 70 OR close < sma",
      },
      customParams: { rsiPeriod: 14, smaPeriod: 20 },
    });
    const d = parseDetails(result);
    expect(d.created).toBe(true);
    expect(typeof d.id).toBe("string");
  });

  // 7. Error: custom strategy without rules
  it("7. custom strategy without rules returns error", async () => {
    const { stratTools } = setup();

    const result = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "Bad Custom",
      type: "custom",
    });
    const d = parseDetails(result);
    expect(d.error).toBeDefined();
    expect(typeof d.error).toBe("string");
    expect(d.error).toContain("rules");
  });

  // 8. Error: backtest nonexistent strategy
  it("8. backtest nonexistent strategy returns clear error", async () => {
    const { stratTools } = setup();

    const result = await stratTools.get("fin_backtest_run")!("conv-1", {
      strategyId: "does-not-exist",
    });
    const d = parseDetails(result);
    expect(d.error).toBeDefined();
    expect(d.error).toContain("not found");
  });

  // 9. Error: walk-forward on wrong level
  it("9. walk-forward on L0 strategy returns level error", async () => {
    const { stratTools } = setup();

    const createResult = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "Wrong Level",
      type: "sma-crossover",
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;

    // L0_INCUBATE -- walk-forward requires L1_BACKTEST
    const wfResult = await stratTools.get("fin_walk_forward_run")!("conv-1", {
      strategyId,
    });
    const d = parseDetails(wfResult);
    expect(d.error).toBeDefined();
    expect(d.error).toContain("L1_BACKTEST");
  });

  // 10. Full research chain: create -> backtest -> paper deploy
  it("10. full research chain: create -> backtest -> list -> paper order", async () => {
    const { stratTools, paperTools } = setup();

    // Step 1: Create strategy
    const s1 = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "Full Research",
      type: "bollinger-bands",
      symbols: ["ETH/USDT"],
    });
    const strategyId = (parseDetails(s1) as { id: string }).id;
    expect(strategyId).toBeTruthy();

    // Step 2: Backtest
    const s2 = await stratTools.get("fin_backtest_run")!("conv-1", {
      strategyId,
      capital: 50000,
    });
    const bt = parseDetails(s2);
    expect(bt.totalReturn).toBeGreaterThan(0);
    expect(bt.sharpe).toBeGreaterThan(0);

    // Step 3: Strategy list
    const s3 = await stratTools.get("fin_strategy_list")!("conv-1", {});
    expect((parseDetails(s3) as { total: number }).total).toBe(1);

    // Step 4: Deploy to paper
    const s4 = await paperTools.get("fin_paper_create")!("conv-1", {
      name: "Research Deploy",
      capital: 50000,
    });
    const accountId = (parseDetails(s4).account as { id: string }).id;

    // Step 5: Paper order tracking strategy
    const s5 = await paperTools.get("fin_paper_order")!("conv-1", {
      account_id: accountId,
      symbol: "ETH/USDT",
      side: "buy",
      quantity: 1,
      current_price: 3500,
      strategy_id: strategyId,
      reason: "Bollinger band squeeze breakout",
    });
    expect(parseDetails(s5).order).toBeDefined();
  });

  // 11. Strategy list with level filter
  it("11. strategy list filters by level correctly", async () => {
    const { stratTools } = setup();

    // Create two strategies
    await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "Strategy A",
      type: "sma-crossover",
    });
    await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "Strategy B",
      type: "rsi-mean-reversion",
    });

    // Both are L0_INCUBATE
    const l0Result = await stratTools.get("fin_strategy_list")!("conv-1", {
      level: "L0_INCUBATE",
    });
    expect((parseDetails(l0Result) as { total: number }).total).toBe(2);

    // No L3_LIVE strategies
    const l3Result = await stratTools.get("fin_strategy_list")!("conv-1", {
      level: "L3_LIVE",
    });
    expect((parseDetails(l3Result) as { total: number }).total).toBe(0);
  });

  // 12. Backtest result before any backtest returns error
  it("12. backtest result before running returns 'no result' error", async () => {
    const { stratTools } = setup();

    const createResult = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "No BT",
      type: "sma-crossover",
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;

    const result = await stratTools.get("fin_backtest_result")!("conv-1", { strategyId });
    const d = parseDetails(result);
    expect(d.error).toBeDefined();
    expect(d.error).toContain("No backtest result");
  });
});
