/**
 * L4 -- LLM Tool Chain: Fund Management
 *
 * Simulates multi-step LLM tool_use sequences for fund management:
 *   1. "Fund status"     -> fin_fund_status -> equity/allocations/risk
 *   2. "Leaderboard"     -> fin_leaderboard -> ranked list with fitness
 *   3. "Rebalance"       -> fin_fund_rebalance -> before/after compare
 *   4. "Promote check"   -> fin_fund_promote -> eligibility check
 *   5. "Risk assessment" -> fin_fund_risk -> drawdown/exposure/level
 *   6. "Allocate"        -> fin_fund_allocate -> capital allocation
 *   7. Lifecycle scan    -> fin_lifecycle_scan -> action list
 *   8. Rebalance with paper data -> cross-module integration
 *   9. Promotions ready  -> fin_list_promotions_ready -> eligible list
 *  10. Fund status after rebalance -> state changes reflected
 *
 * Zero LLM cost -- no API key needed.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/l4-fund-management-chain.test.ts
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

function makeMockBacktestService() {
  return {
    async submit() {
      return {
        task: { task_id: "mock-fund", status: "completed" },
        report: {
          task_id: "mock-fund",
          performance: {
            totalReturn: 18.0,
            sharpe: 1.5,
            sortino: 1.8,
            maxDrawdown: -6.0,
            calmar: 1.2,
            winRate: 62.0,
            profitFactor: 2.3,
            totalTrades: 45,
            finalEquity: 11800,
          },
          equity_curve: [
            { date: "2024-01-01", equity: 10000 },
            { date: "2024-06-01", equity: 11800 },
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
  tmpDir = mkdtempSync(join(tmpdir(), "l4-fund-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================

describe("L4 -- Fund Management Chain", () => {
  function setupAll() {
    const registry = new StrategyRegistry(join(tmpDir, "s.json"));
    const bridge = new RemoteBacktestBridge(() => makeMockBacktestService() as never);
    const manager = new FundManager(join(tmpDir, "fund.json"), FUND_CONFIG);
    const flowStore = new CapitalFlowStore(join(tmpDir, "flows.sqlite"));
    const perfStore = new PerformanceSnapshotStore(join(tmpDir, "perf.sqlite"));
    const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
    manager.markDayStart(FUND_CONFIG.totalCapital);

    const { api: api1, tools: fundTools } = captureTools();
    registerFundTools(api1 as never, {
      manager,
      config: FUND_CONFIG,
      flowStore,
      perfStore,
      getRegistry: () => registry as never,
      getPaper: () => paperEngine as never,
    });

    const { api: api2, tools: stratTools } = captureTools();
    registerStrategyTools(api2 as never, registry, bridge, null, paperEngine);

    return { registry, manager, fundTools, stratTools, paperEngine };
  }

  // Helper: seed N strategies with backtest results, promoted to L1_BACKTEST
  async function seedStrategies(
    stratTools: Map<string, ToolExecuteFn>,
    count: number,
    registry?: StrategyRegistry,
  ): Promise<string[]> {
    const ids: string[] = [];
    const types = [
      "sma-crossover",
      "rsi-mean-reversion",
      "bollinger-bands",
      "macd-divergence",
      "trend-following-momentum",
    ];
    for (let i = 0; i < count; i++) {
      const result = await stratTools.get("fin_strategy_create")!("conv-1", {
        name: `Strategy ${i + 1}`,
        type: types[i % types.length],
      });
      const id = (parseDetails(result) as { id: string }).id;
      await stratTools.get("fin_backtest_run")!("conv-1", { strategyId: id });
      // Promote to L1_BACKTEST so leaderboard includes them
      registry?.updateLevel(id, "L1_BACKTEST");
      ids.push(id);
    }
    return ids;
  }

  // 1. Fund status
  it("1. fund status returns equity, allocations, risk, and strategy counts", async () => {
    const { fundTools, stratTools, registry } = setupAll();
    await seedStrategies(stratTools, 2, registry);

    const result = await fundTools.get("fin_fund_status")!("conv-1", {});
    const d = parseDetails(result);

    expect(typeof d.totalCapital).toBe("number");
    expect(typeof d.totalEquity).toBe("number");
    expect(d.totalCapital).toBe(100000);
    expect(Array.isArray(d.allocations)).toBe(true);
    expect(typeof d.totalStrategies).toBe("number");
    expect(d.totalStrategies).toBe(2);
    expect(d).toHaveProperty("risk");
    expect(d).toHaveProperty("byLevel");

    const byLevel = d.byLevel as Record<string, number>;
    expect(typeof byLevel.L0_INCUBATE).toBe("number");
    expect(typeof byLevel.L1_BACKTEST).toBe("number");
  });

  // 2. Leaderboard
  it("2. leaderboard returns ranked list with fitness scores", async () => {
    const { fundTools, stratTools, registry } = setupAll();
    await seedStrategies(stratTools, 3, registry);

    const result = await fundTools.get("fin_leaderboard")!("conv-1", {});
    const d = parseDetails(result);

    expect(Array.isArray(d.leaderboard)).toBe(true);
    expect(d.total).toBe(3);

    const lb = d.leaderboard as Array<{ strategyId: string; fitness: number; rank: number }>;
    expect(lb.length).toBe(3);
    for (const entry of lb) {
      expect(typeof entry.strategyId).toBe("string");
      expect(typeof entry.fitness).toBe("number");
      expect(typeof entry.rank).toBe("number");
    }
  });

  // 3. Fund allocate
  it("3. fund allocate computes capital distribution with cash reserve", async () => {
    const { fundTools, stratTools, registry } = setupAll();
    await seedStrategies(stratTools, 2, registry);

    const result = await fundTools.get("fin_fund_allocate")!("conv-1", {});
    const d = parseDetails(result);

    expect(Array.isArray(d.allocations)).toBe(true);
    expect(typeof d.totalAllocated).toBe("number");
    expect(typeof d.cashReserve).toBe("number");
    // Total allocated + cash reserve should approximately equal total capital
    expect((d.totalAllocated as number) + (d.cashReserve as number)).toBeCloseTo(100000, -2);
  });

  // 4. Fund rebalance
  it("4. rebalance returns allocations, leaderboard, risk, and promotion/demotion lists", async () => {
    const { fundTools, stratTools, registry } = setupAll();
    await seedStrategies(stratTools, 2, registry);

    const result = await fundTools.get("fin_fund_rebalance")!("conv-1", {});
    const d = parseDetails(result);

    expect(d).toHaveProperty("allocations");
    expect(d).toHaveProperty("leaderboard");
    expect(d).toHaveProperty("risk");
    expect(d).toHaveProperty("promotions");
    expect(d).toHaveProperty("demotions");
    expect(Array.isArray(d.allocations)).toBe(true);
    expect(Array.isArray(d.promotions)).toBe(true);
    expect(Array.isArray(d.demotions)).toBe(true);
  });

  // 5. Fund promote check
  it("5. promote check returns eligibility with reasons", async () => {
    const { fundTools, stratTools, registry } = setupAll();
    const [strategyId] = await seedStrategies(stratTools, 1, registry);

    const result = await fundTools.get("fin_fund_promote")!("conv-1", { strategyId });
    const d = parseDetails(result);

    expect(d).toHaveProperty("strategyId");
    expect(d).toHaveProperty("currentLevel");
    expect(d).toHaveProperty("eligible");
    expect(typeof d.eligible).toBe("boolean");
    // If not eligible, should have blockers or reasons
    if (!d.eligible) {
      expect(d.blockers || d.reasons).toBeTruthy();
    }
  });

  // 6. Fund risk assessment
  it("6. risk assessment returns risk level, drawdown, and action recommendations", async () => {
    const { fundTools } = setupAll();

    const result = await fundTools.get("fin_fund_risk")!("conv-1", {});
    const d = parseDetails(result);

    expect(d).toHaveProperty("riskLevel");
    expect(typeof d.riskLevel).toBe("string");
    expect(typeof d.scaleFactor).toBe("number");
    expect(Array.isArray(d.actions)).toBe(true);
    // Normal state should recommend normal operations
    const actions = d.actions as string[];
    expect(actions.length).toBeGreaterThan(0);
  });

  // 7. Lifecycle scan
  it("7. lifecycle scan returns actionable items with tool hints", async () => {
    const { fundTools, stratTools, registry } = setupAll();
    await seedStrategies(stratTools, 3, registry);

    const result = await fundTools.get("fin_lifecycle_scan")!("conv-1", {});
    const d = parseDetails(result);

    expect(Array.isArray(d.actions)).toBe(true);
    expect(d).toHaveProperty("summary");
    const summary = d.summary as Record<string, unknown>;
    expect(typeof summary.totalStrategies).toBe("number");
    expect(typeof summary.actionableCount).toBe("number");
    expect(typeof summary.riskLevel).toBe("string");

    // Each action should have tool recommendation
    const actions = d.actions as Array<{
      strategyId: string;
      action: string;
      tool: string;
    }>;
    for (const action of actions) {
      expect(typeof action.strategyId).toBe("string");
      expect(typeof action.action).toBe("string");
      expect(typeof action.tool).toBe("string");
    }
  });

  // 8. Promotions ready
  it("8. promotions ready returns eligible list with confirmation flags", async () => {
    const { fundTools, stratTools, registry } = setupAll();
    await seedStrategies(stratTools, 2, registry);

    const result = await fundTools.get("fin_list_promotions_ready")!("conv-1", {});
    const d = parseDetails(result);

    expect(Array.isArray(d.promotions)).toBe(true);
    expect(d).toHaveProperty("summary");
    const summary = d.summary as Record<string, number>;
    expect(typeof summary.total).toBe("number");
    expect(typeof summary.eligible).toBe("number");
    expect(typeof summary.needsConfirmation).toBe("number");
    expect(typeof summary.autoPromote).toBe("number");
  });

  // 9. Promote nonexistent strategy returns error
  it("9. promote check for nonexistent strategy returns clear error", async () => {
    const { fundTools } = setupAll();

    const result = await fundTools.get("fin_fund_promote")!("conv-1", {
      strategyId: "nonexistent-id",
    });
    const d = parseDetails(result);
    expect(d.error).toBeDefined();
    expect(d.error).toContain("not found");
  });

  // 10. Full fund management chain: status -> allocate -> rebalance -> risk
  it("10. full fund chain: status -> allocate -> rebalance -> risk -> leaderboard", async () => {
    const { fundTools, stratTools, registry } = setupAll();
    await seedStrategies(stratTools, 3, registry);

    // Step 1: Status
    const status = parseDetails(await fundTools.get("fin_fund_status")!("conv-1", {}));
    expect(status.totalCapital).toBe(100000);
    expect(status.totalStrategies).toBe(3);

    // Step 2: Allocate
    const alloc = parseDetails(await fundTools.get("fin_fund_allocate")!("conv-1", {}));
    expect(Array.isArray(alloc.allocations)).toBe(true);

    // Step 3: Rebalance
    const rebal = parseDetails(await fundTools.get("fin_fund_rebalance")!("conv-1", {}));
    expect(rebal.allocations).toBeDefined();
    expect(rebal.risk).toBeDefined();

    // Step 4: Risk
    const risk = parseDetails(await fundTools.get("fin_fund_risk")!("conv-1", {}));
    expect(risk.riskLevel).toBeDefined();

    // Step 5: Leaderboard
    const lb = parseDetails(await fundTools.get("fin_leaderboard")!("conv-1", {}));
    expect(lb.total).toBe(3);
  });

  // 11. Leaderboard with level filter
  it("11. leaderboard filters by level", async () => {
    const { fundTools, stratTools, registry } = setupAll();
    await seedStrategies(stratTools, 2, registry);

    // Filter L3_LIVE -- should be empty
    const result = await fundTools.get("fin_leaderboard")!("conv-1", { level: "L3_LIVE" });
    const d = parseDetails(result);
    expect(d.total).toBe(0);
    expect((d.leaderboard as unknown[]).length).toBe(0);
  });

  // 12. Fund status with no strategies
  it("12. fund status with zero strategies shows empty allocations", async () => {
    const { fundTools } = setupAll();

    const result = await fundTools.get("fin_fund_status")!("conv-1", {});
    const d = parseDetails(result);

    expect(d.totalStrategies).toBe(0);
    expect((d.allocations as unknown[]).length).toBe(0);
    const byLevel = d.byLevel as Record<string, number>;
    expect(byLevel.L0_INCUBATE).toBe(0);
  });
});
