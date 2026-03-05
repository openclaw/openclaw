/**
 * L4 — LLM Tool Chain: simulates multi-step LLM tool_use sequences
 * by constructing MockToolUse objects and calling execute() directly.
 *
 * Zero LLM cost — no API key needed.
 *
 * Scenarios:
 *   A: Strategy create → backtest → list (3 tests)
 *   B: Lifecycle scan → promote → status check (3 tests)
 *   C: Paper create → order → positions → metrics (3 tests)
 *   D: Full 6-step chain + error handling + state query (3 tests)
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/l4-llm-tool-chain.test.ts
 */
vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapitalFlowStore } from "../../../src/fund/capital-flow-store.js";
import { FundManager } from "../../../src/fund/fund-manager.js";
import { PerformanceSnapshotStore } from "../../../src/fund/performance-snapshot-store.js";
import { registerFundTools } from "../../../src/fund/tools.js";
import { PaperEngine } from "../../../src/paper/paper-engine.js";
import { PaperStore } from "../../../src/paper/paper-store.js";
import { registerPaperTools } from "../../../src/paper/tools.js";
import { RemoteBacktestBridge } from "../../../src/strategy/remote-backtest-bridge.js";
import { StrategyRegistry } from "../../../src/strategy/strategy-registry.js";
import { registerStrategyTools } from "../../../src/strategy/tools.js";

// ── Types ──

type ToolExecuteFn = (
  id: string,
  params: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: unknown;
}>;

// ── Helpers ──

function captureTools(serviceOverrides?: Map<string, unknown>) {
  const tools = new Map<string, ToolExecuteFn>();
  const api = {
    registerTool: vi.fn(
      (def: { name: string; execute: ToolExecuteFn }, opts: { names: string[] }) => {
        for (const name of opts.names) {
          tools.set(name, def.execute.bind(def));
        }
      },
    ),
    runtime: { services: serviceOverrides ?? new Map() },
  };
  return { api, tools };
}

function parseDetails(result: { details: unknown }): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

function makeMockBacktestService() {
  return {
    async submit() {
      return {
        task: { task_id: "mock-chain", status: "completed" },
        report: {
          task_id: "mock-chain",
          performance: {
            totalReturn: 15.0,
            sharpe: 1.3,
            sortino: 1.6,
            maxDrawdown: -7.0,
            calmar: 1.0,
            winRate: 58.0,
            profitFactor: 2.0,
            totalTrades: 30,
            finalEquity: 11500,
          },
          equity_curve: [
            { date: "2024-01-01", equity: 10000 },
            { date: "2024-06-01", equity: 11500 },
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
        equityCurve: [10000, 11500],
        dailyReturns: [0.15],
      };
    },
  };
}

const FUND_CONFIG = {
  totalCapital: 100000,
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "weekly" as const,
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l4-chain-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario A: Strategy create → backtest → list
// ═══════════════════════════════════════════════════════════════

describe("L4 — Scenario A: Strategy → Backtest → List", () => {
  it("A.1 create strategy returns valid id and L0 level", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "s.json"));
    const bridge = new RemoteBacktestBridge(() => makeMockBacktestService() as never);
    const { api, tools } = captureTools();
    registerStrategyTools(api as never, registry, bridge, null, null);

    const result = await tools.get("fin_strategy_create")!("conv-1", {
      name: "Chain Test A",
      type: "sma-crossover",
      parameters: { fastPeriod: 5, slowPeriod: 20 },
    });

    const d = parseDetails(result);
    expect(d.created).toBe(true);
    expect(typeof d.id).toBe("string");
    expect(d.level).toBe("L0_INCUBATE");
  });

  it("A.2 backtest returns numeric metrics after create", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "s.json"));
    const bridge = new RemoteBacktestBridge(() => makeMockBacktestService() as never);
    const { api, tools } = captureTools();
    registerStrategyTools(api as never, registry, bridge, null, null);

    // Step 1: Create
    const createResult = await tools.get("fin_strategy_create")!("conv-1", {
      name: "Chain BT",
      type: "sma-crossover",
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;

    // Step 2: Backtest
    const btResult = await tools.get("fin_backtest_run")!("conv-1", { strategyId });
    const bt = parseDetails(btResult);

    expect(typeof bt.totalReturn).toBe("number");
    expect(typeof bt.sharpe).toBe("number");
    expect(typeof bt.finalEquity).toBe("number");
    expect(bt.totalReturn as number).toBeGreaterThan(0);
  });

  it("A.3 list shows created strategy after full chain", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "s.json"));
    const bridge = new RemoteBacktestBridge(() => makeMockBacktestService() as never);
    const { api, tools } = captureTools();
    registerStrategyTools(api as never, registry, bridge, null, null);

    // Step 1: Create
    await tools.get("fin_strategy_create")!("conv-1", {
      name: "Chain List Test",
      type: "rsi-mean-reversion",
    });

    // Step 2: Backtest (optional but part of the chain)
    // Step 3: List
    const listResult = await tools.get("fin_strategy_list")!("conv-1", {});
    const list = parseDetails(listResult);

    expect(list.total).toBe(1);
    expect(Array.isArray(list.strategies)).toBe(true);
    const strategies = list.strategies as Array<{ name: string }>;
    expect(strategies[0].name).toBe("Chain List Test");
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario B: Lifecycle scan → promote → status check
// ═══════════════════════════════════════════════════════════════

describe("L4 — Scenario B: Lifecycle scan → promote → status", () => {
  function setupFundTools() {
    const registry = new StrategyRegistry(join(tmpDir, "s.json"));
    const manager = new FundManager(join(tmpDir, "fund.json"), FUND_CONFIG);
    const flowStore = new CapitalFlowStore(join(tmpDir, "flows.sqlite"));
    const perfStore = new PerformanceSnapshotStore(join(tmpDir, "perf.sqlite"));
    const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
    manager.markDayStart(FUND_CONFIG.totalCapital);

    const { api, tools } = captureTools();
    registerFundTools(api as never, {
      manager,
      config: FUND_CONFIG,
      flowStore,
      perfStore,
      getRegistry: () => registry as never,
      getPaper: () => paperEngine as never,
    });

    return { registry, manager, tools };
  }

  it("B.1 lifecycle scan returns actions and summary", async () => {
    const { tools } = setupFundTools();

    const result = await tools.get("fin_lifecycle_scan")!("conv-1", {});
    const d = parseDetails(result);

    expect(d).toHaveProperty("actions");
    expect(d).toHaveProperty("summary");
    expect(Array.isArray(d.actions)).toBe(true);
    const summary = d.summary as Record<string, unknown>;
    expect(typeof summary.totalStrategies).toBe("number");
  });

  it("B.2 fund promote returns promotion check with eligibility", async () => {
    const { registry, tools } = setupFundTools();

    // Create a strategy directly in the registry
    registry.create({
      name: "Promote Test",
      version: "1.0",
      definition: { type: "sma-crossover", parameters: {} } as never,
    });
    const strategies = registry.list();
    const strategyId = strategies[0].id;

    const result = await tools.get("fin_fund_promote")!("conv-1", {
      strategyId,
    });
    const d = parseDetails(result);

    // PromotionCheck returns: strategyId, currentLevel, eligible, targetLevel, reasons, blockers
    expect(d).toHaveProperty("strategyId");
    expect(d).toHaveProperty("currentLevel");
    expect(d).toHaveProperty("eligible");
    expect(typeof d.eligible).toBe("boolean");
  });

  it("B.3 fund status returns portfolio snapshot", async () => {
    const { tools } = setupFundTools();

    const result = await tools.get("fin_fund_status")!("conv-1", {});
    const d = parseDetails(result);

    expect(d).toHaveProperty("totalCapital");
    expect(d).toHaveProperty("totalEquity");
    expect(d).toHaveProperty("allocations");
    expect(typeof d.totalCapital).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario C: Paper create → order → positions → metrics
// ═══════════════════════════════════════════════════════════════

describe("L4 — Scenario C: Paper account full chain", () => {
  function setupPaperTools() {
    const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
    const { api, tools } = captureTools();
    registerPaperTools(api as never, paperEngine);
    return { paperEngine, tools };
  }

  it("C.1 create paper account returns account with capital", async () => {
    const { tools } = setupPaperTools();

    const result = await tools.get("fin_paper_create")!("conv-1", {
      name: "BTC Swing",
      capital: 10000,
    });
    const d = parseDetails(result);

    expect(d.message).toContain("BTC Swing");
    expect(d.account).toBeDefined();
    const account = d.account as { id: string; equity: number };
    expect(typeof account.id).toBe("string");
    expect(account.equity).toBe(10000);
  });

  it("C.2 paper order fills at simulated price", async () => {
    const { tools } = setupPaperTools();

    // Step 1: Create account
    const createResult = await tools.get("fin_paper_create")!("conv-1", {
      name: "Order Test",
      capital: 50000,
    });
    const accountId = (parseDetails(createResult).account as { id: string }).id;

    // Step 2: Place order
    const orderResult = await tools.get("fin_paper_order")!("conv-1", {
      account_id: accountId,
      symbol: "BTC/USDT",
      side: "buy",
      quantity: 0.1,
      current_price: 65000,
    });
    const order = parseDetails(orderResult);

    expect(order.order).toBeDefined();
    const o = order.order as { side: string; symbol: string; quantity: number; status: string };
    expect(o.side).toBe("buy");
    expect(o.symbol).toBe("BTC/USDT");
    expect(o.quantity).toBeGreaterThan(0);
  });

  it("C.3 positions and metrics reflect order after chain", async () => {
    const { tools } = setupPaperTools();

    // Step 1: Create account
    const createResult = await tools.get("fin_paper_create")!("conv-1", {
      name: "Metrics Chain",
      capital: 50000,
    });
    const accountId = (parseDetails(createResult).account as { id: string }).id;

    // Step 2: Place order
    await tools.get("fin_paper_order")!("conv-1", {
      account_id: accountId,
      symbol: "ETH/USDT",
      side: "buy",
      quantity: 1,
      current_price: 3500,
    });

    // Step 3: Check positions
    const posResult = await tools.get("fin_paper_positions")!("conv-1", {
      account_id: accountId,
    });
    const pos = parseDetails(posResult);
    expect(Array.isArray(pos.positions)).toBe(true);
    const positions = pos.positions as Array<{ symbol: string }>;
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[0].symbol).toBe("ETH/USDT");

    // Step 4: Check metrics
    const metricsResult = await tools.get("fin_paper_metrics")!("conv-1", {
      account_id: accountId,
    });
    const m = parseDetails(metricsResult);
    expect(m).toHaveProperty("metrics");
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario D: Full 6-step chain + error handling
// ═══════════════════════════════════════════════════════════════

describe("L4 — Scenario D: Full chain + error handling", () => {
  it("D.1 complete 6-step flow: create → backtest → list → paper → order → positions", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "s.json"));
    const bridge = new RemoteBacktestBridge(() => makeMockBacktestService() as never);
    const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });

    const { api: api1, tools: stratTools } = captureTools();
    registerStrategyTools(api1 as never, registry, bridge, null, paperEngine);

    const { api: api2, tools: paperTools } = captureTools();
    registerPaperTools(api2 as never, paperEngine);

    // Step 1: Create strategy
    const s1 = await stratTools.get("fin_strategy_create")!("conv-1", {
      name: "Full Chain",
      type: "sma-crossover",
      parameters: { fastPeriod: 5, slowPeriod: 20 },
    });
    const strategyId = (parseDetails(s1) as { id: string }).id;
    expect(strategyId).toBeTruthy();

    // Step 2: Backtest
    const s2 = await stratTools.get("fin_backtest_run")!("conv-1", { strategyId });
    expect((parseDetails(s2) as { sharpe: number }).sharpe).toBeGreaterThan(0);

    // Step 3: List strategies
    const s3 = await stratTools.get("fin_strategy_list")!("conv-1", {});
    expect((parseDetails(s3) as { total: number }).total).toBe(1);

    // Step 4: Create paper account
    const s4 = await paperTools.get("fin_paper_create")!("conv-1", {
      name: "Full Chain Paper",
      capital: 10000,
    });
    const accountId = (parseDetails(s4).account as { id: string }).id;

    // Step 5: Paper order
    const s5 = await paperTools.get("fin_paper_order")!("conv-1", {
      account_id: accountId,
      symbol: "BTC/USDT",
      side: "buy",
      quantity: 0.01,
      current_price: 65000,
      strategy_id: strategyId,
    });
    expect(parseDetails(s5).order).toBeDefined();

    // Step 6: Check positions
    const s6 = await paperTools.get("fin_paper_positions")!("conv-1", {
      account_id: accountId,
    });
    const positions = (parseDetails(s6) as { positions: unknown[] }).positions;
    expect(positions.length).toBe(1);
  });

  it("D.2 error handling: backtest nonexistent strategy returns error", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "s.json"));
    const bridge = new RemoteBacktestBridge(() => makeMockBacktestService() as never);
    const { api, tools } = captureTools();
    registerStrategyTools(api as never, registry, bridge, null, null);

    const result = await tools.get("fin_backtest_run")!("conv-1", {
      strategyId: "nonexistent-id",
    });
    const d = parseDetails(result);
    expect(d.error).toBeDefined();
    expect(typeof d.error).toBe("string");
  });

  it("D.3 paper order on nonexistent account returns rejected order", async () => {
    const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
    const { api, tools } = captureTools();
    registerPaperTools(api as never, paperEngine);

    const result = await tools.get("fin_paper_order")!("conv-1", {
      account_id: "nonexistent",
      symbol: "BTC/USDT",
      side: "buy",
      quantity: 0.1,
      current_price: 65000,
    });
    const d = parseDetails(result);
    // PaperEngine returns a PaperOrder with reason/status, or error wrapper
    const order = d.order as { status?: string; reason?: string } | undefined;
    if (order) {
      // Returns rejected order with reason
      expect(order.reason ?? order.status).toBeTruthy();
    } else {
      // Returns error wrapper
      expect(d.error).toBeDefined();
    }
  });
});
