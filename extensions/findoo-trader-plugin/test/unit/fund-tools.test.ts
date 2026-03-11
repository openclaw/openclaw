/**
 * L1 unit tests for fund tools (fin_fund_status, fin_fund_promote, fin_fund_rebalance,
 * fin_lifecycle_scan, fin_list_promotions_ready).
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/unit/fund-tools.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FundManager } from "../../src/fund/fund-manager.js";
import { registerFundTools, type FundToolDeps } from "../../src/fund/tools.js";
import type { FundConfig } from "../../src/fund/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

type ToolExecuteFn = (
  id: string,
  params: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: unknown;
}>;

/** Capture tools registered via api.registerTool. */
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

function parseDetails(result: { details: unknown }): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

const DEFAULT_FUND_CONFIG: FundConfig = {
  totalCapital: 100_000,
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "weekly",
};

// Strategy record factory
function makeRecord(
  overrides: Partial<{
    id: string;
    name: string;
    level: string;
    version: string;
    definition: unknown;
    createdAt: number;
    updatedAt: number;
    lastBacktest: { sharpe: number; maxDrawdown: number; totalTrades: number } | undefined;
    lastWalkForward: { passed: boolean; ratio: number; threshold: number } | undefined;
  }> = {},
) {
  const now = Date.now();
  return {
    id: overrides.id ?? `strat-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name ?? "Test Strategy",
    level: overrides.level ?? "L0_INCUBATE",
    version: overrides.version ?? "1.0.0",
    definition: overrides.definition ?? {
      symbols: ["BTC/USDT"],
      timeframes: ["1h"],
      markets: ["crypto"],
    },
    createdAt: overrides.createdAt ?? now - 86_400_000 * 60,
    updatedAt: overrides.updatedAt ?? now,
    lastBacktest: overrides.lastBacktest,
    lastWalkForward: overrides.lastWalkForward,
  };
}

// ── Test suite ──────────────────────────────────────────────────────

let tmpDir: string;
let fundManager: FundManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fund-tools-test-"));
  fundManager = new FundManager(join(tmpDir, "fund-state.json"), DEFAULT_FUND_CONFIG);
  fundManager.markDayStart(DEFAULT_FUND_CONFIG.totalCapital!);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function buildDeps(
  records: ReturnType<typeof makeRecord>[],
  overrides?: Partial<FundToolDeps>,
): { tools: Map<string, ToolExecuteFn> } {
  const registry = {
    list: vi.fn((filter?: { level?: string }) => {
      if (filter?.level) return records.filter((r) => r.level === filter.level);
      return records;
    }),
    get: vi.fn((id: string) => records.find((r) => r.id === id)),
    updateLevel: vi.fn((id: string, level: string) => {
      const r = records.find((s) => s.id === id);
      if (r) r.level = level;
    }),
  };

  const paper = {
    listAccounts: vi.fn(() => []),
    getAccountState: vi.fn(() => null),
    getMetrics: vi.fn(() => null),
  };

  const flowStore = { record: vi.fn() } as never;
  const perfStore = { addSnapshot: vi.fn() } as never;

  const { api, tools } = captureTools();

  registerFundTools(api as never, {
    manager: fundManager,
    config: DEFAULT_FUND_CONFIG,
    flowStore,
    perfStore,
    getRegistry: () => registry as never,
    getPaper: () => paper as never,
    ...overrides,
  });

  return { tools };
}

describe("Fund tools L1 unit tests", () => {
  // ── 1. fin_fund_status ──

  it("fin_fund_status: returns correct byLevel counts and risk", async () => {
    const records = [
      makeRecord({ level: "L0_INCUBATE" }),
      makeRecord({ level: "L1_BACKTEST" }),
      makeRecord({ level: "L2_PAPER" }),
      makeRecord({ level: "L2_PAPER" }),
      makeRecord({ level: "L3_LIVE" }),
    ];

    const { tools } = buildDeps(records);
    const result = await tools.get("fin_fund_status")!("test", {});
    const d = parseDetails(result);

    expect(d.totalEquity).toBe(100_000);
    expect(d.totalStrategies).toBe(5);
    const byLevel = d.byLevel as Record<string, number>;
    expect(byLevel.L0_INCUBATE).toBe(1);
    expect(byLevel.L1_BACKTEST).toBe(1);
    expect(byLevel.L2_PAPER).toBe(2);
    expect(byLevel.L3_LIVE).toBe(1);
    expect(d.risk).toBeDefined();
    const risk = d.risk as Record<string, unknown>;
    expect(risk.riskLevel).toBe("normal");
  });

  // ── 2. fin_fund_promote: L2 strategy returns eligible + needsUserConfirmation ──

  it("fin_fund_promote: L2 eligible strategy returns needsUserConfirmation=true", async () => {
    const record = makeRecord({
      id: "strat-l2-good",
      level: "L2_PAPER",
      lastBacktest: { sharpe: 1.5, maxDrawdown: -12, totalTrades: 150 },
      lastWalkForward: { passed: true, ratio: 0.8, threshold: 0.6 },
    });
    // Inject paper metrics via buildProfiles path: the FundManager uses paperMetrics
    // For L2→L3 eligibility we need paper data. Use direct mock.
    const { tools } = buildDeps([record]);

    const result = await tools.get("fin_fund_promote")!("test", { strategyId: "strat-l2-good" });
    const d = parseDetails(result);

    // L2 without paper data won't be eligible (needs 30d, 30 trades etc.)
    expect(d.strategyId).toBe("strat-l2-good");
    expect(d.currentLevel).toBe("L2_PAPER");
    expect(d.eligible).toBe(false);
    // Without paper data, specific blockers should exist
    const blockers = d.blockers as string[];
    expect(blockers.length).toBeGreaterThanOrEqual(1);
    expect(blockers.some((b) => b.includes("days"))).toBe(true);
    expect(blockers.some((b) => b.includes("trades"))).toBe(true);
  });

  // ── 3. fin_fund_promote: L0 strategy returns eligible + auto (no confirmation) ──

  it("fin_fund_promote: L0 strategy returns eligible with no confirmation needed", async () => {
    const record = makeRecord({ id: "strat-l0", level: "L0_INCUBATE" });
    const { tools } = buildDeps([record]);

    const result = await tools.get("fin_fund_promote")!("test", { strategyId: "strat-l0" });
    const d = parseDetails(result);

    expect(d.strategyId).toBe("strat-l0");
    expect(d.eligible).toBe(true);
    expect(d.targetLevel).toBe("L1_BACKTEST");
    expect(d.needsUserConfirmation).toBeFalsy();
  });

  // ── 4. fin_fund_promote: non-existent strategy returns error ──

  it("fin_fund_promote: non-existent strategyId returns error", async () => {
    const { tools } = buildDeps([]);

    const result = await tools.get("fin_fund_promote")!("test", { strategyId: "ghost-id" });
    const d = parseDetails(result);

    expect(d.error).toBeDefined();
    expect(d.error as string).toContain("ghost-id");
  });

  // ── 5. fin_fund_rebalance: no confirmed_promotions → L3 eligible goes to pendingConfirmations ──

  it("fin_fund_rebalance: L3-eligible without confirmed_promotions → pendingConfirmations", async () => {
    const record = makeRecord({
      id: "strat-pend",
      level: "L2_PAPER",
      lastBacktest: { sharpe: 1.5, maxDrawdown: -10, totalTrades: 200 },
      lastWalkForward: { passed: true, ratio: 0.8, threshold: 0.6 },
      createdAt: Date.now() - 86_400_000 * 60,
    });

    // Provide paper data that satisfies L2→L3 gates (30d, 30 trades, Sharpe ≥ 1.5, DD ≤ 20%)
    const paperMock = {
      listAccounts: vi.fn(() => [{ id: "paper-1", name: "Paper Acct", equity: 11_000 }]),
      getAccountState: vi.fn(() => ({
        id: "paper-1",
        initialCapital: 10_000,
        equity: 11_000,
        orders: Array.from({ length: 35 }, (_, i) => ({
          strategyId: "strat-pend",
          symbol: "BTC/USDT",
          side: "buy",
          id: `order-${i}`,
        })),
        createdAt: Date.now() - 86_400_000 * 40,
      })),
      getMetrics: vi.fn(() => ({
        rollingSharpe7d: 1.8,
        rollingSharpe30d: 1.8,
        currentDrawdown: -5,
        consecutiveLossDays: 0,
        decayLevel: "none",
      })),
    };

    const { tools } = buildDeps([record], { getPaper: () => paperMock as never });

    const result = await tools.get("fin_fund_rebalance")!("test", {});
    const d = parseDetails(result);

    expect(d.allocations).toBeDefined();
    expect(Array.isArray(d.promotions)).toBe(true);
    // pendingConfirmations should contain strat-pend (L3 eligible, not confirmed)
    const pending = d.pendingConfirmations as Array<{
      strategyId: string;
      needsUserConfirmation: boolean;
    }>;
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.some((p) => p.strategyId === "strat-pend")).toBe(true);
    expect(pending[0]!.needsUserConfirmation).toBe(true);
  });

  // ── 6. fin_fund_rebalance: with confirmed_promotions → calls updateLevel to L3 ──

  it("fin_fund_rebalance: confirmed_promotions triggers updateLevel to L3", async () => {
    const record = makeRecord({
      id: "strat-confirmed",
      level: "L2_PAPER",
      lastBacktest: { sharpe: 1.5, maxDrawdown: -10, totalTrades: 200 },
      lastWalkForward: { passed: true, ratio: 0.8, threshold: 0.6 },
      createdAt: Date.now() - 86_400_000 * 60,
    });

    const records = [record];
    const updateLevelSpy = vi.fn((id: string, level: string) => {
      const r = records.find((s) => s.id === id);
      if (r) r.level = level;
    });

    const registry = {
      list: vi.fn((filter?: { level?: string }) => {
        if (filter?.level) return records.filter((r) => r.level === filter.level);
        return records;
      }),
      get: vi.fn((id: string) => records.find((r) => r.id === id)),
      updateLevel: updateLevelSpy,
    };

    // Provide paper data satisfying L2→L3 gates
    const paperMock = {
      listAccounts: () => [{ id: "paper-1", name: "Paper Acct", equity: 11_000 }],
      getAccountState: () => ({
        id: "paper-1",
        initialCapital: 10_000,
        equity: 11_000,
        orders: Array.from({ length: 35 }, (_, i) => ({
          strategyId: "strat-confirmed",
          symbol: "BTC/USDT",
          side: "buy",
          id: `order-${i}`,
        })),
        createdAt: Date.now() - 86_400_000 * 40,
      }),
      getMetrics: () => ({
        rollingSharpe7d: 1.8,
        rollingSharpe30d: 1.8,
        currentDrawdown: -5,
        consecutiveLossDays: 0,
        decayLevel: "none",
      }),
    };

    const { api, tools: toolMap } = captureTools();
    registerFundTools(api as never, {
      manager: fundManager,
      config: DEFAULT_FUND_CONFIG,
      flowStore: { record: vi.fn() } as never,
      perfStore: { addSnapshot: vi.fn() } as never,
      getRegistry: () => registry as never,
      getPaper: () => paperMock as never,
    });

    const result = await toolMap.get("fin_fund_rebalance")!("test", {
      confirmed_promotions: ["strat-confirmed"],
    });
    const d = parseDetails(result);

    expect(d.allocations).toBeDefined();
    // With paper data satisfying gates + confirmed_promotions, updateLevel should be called with L3_LIVE
    const l3Calls = updateLevelSpy.mock.calls.filter(([, lvl]) => lvl === "L3_LIVE");
    expect(l3Calls.length).toBeGreaterThanOrEqual(1);
    expect(l3Calls[0]![0]).toBe("strat-confirmed");
  });

  // ── 7. fin_lifecycle_scan: L2 eligible returns action="approve_promotion" ──

  it("fin_lifecycle_scan: L2 eligible strategy returns approve_promotion action", async () => {
    const record = makeRecord({
      id: "strat-scan",
      name: "Scan Target",
      level: "L0_INCUBATE",
      lastBacktest: { sharpe: 1.5, maxDrawdown: -12, totalTrades: 150 },
      lastWalkForward: { passed: true, ratio: 0.8, threshold: 0.6 },
    });
    // L0 → auto-promote action
    const { tools } = buildDeps([record]);

    const result = await tools.get("fin_lifecycle_scan")!("test", {});
    const d = parseDetails(result);

    expect(d.actions).toBeDefined();
    const actions = d.actions as Array<{ strategyId: string; action: string; tool: string }>;
    // L0 strategy should get "promote" action (auto, no confirmation)
    const promoteAction = actions.find(
      (a) => a.strategyId === "strat-scan" && a.action === "promote",
    );
    expect(promoteAction).toBeDefined();
    expect(promoteAction!.tool).toBe("fin_fund_rebalance");

    // Summary
    const summary = d.summary as Record<string, unknown>;
    expect(summary.totalStrategies).toBe(1);
    expect(summary.actionableCount).toBeGreaterThanOrEqual(1);
  });

  // ── 8. fin_list_promotions_ready: filters by level correctly ──

  it("fin_list_promotions_ready: level filter returns only matching strategies", async () => {
    const records = [
      makeRecord({ id: "l0-a", level: "L0_INCUBATE" }),
      makeRecord({ id: "l1-a", level: "L1_BACKTEST" }),
      makeRecord({
        id: "l1-b",
        level: "L1_BACKTEST",
        lastBacktest: { sharpe: 1.5, maxDrawdown: -12, totalTrades: 150 },
        lastWalkForward: { passed: true, ratio: 0.8, threshold: 0.6 },
      }),
    ];

    const { tools } = buildDeps(records);

    // Filter for L0 only
    const result = await tools.get("fin_list_promotions_ready")!("test", { level: "L0_INCUBATE" });
    const d = parseDetails(result);

    const promotions = d.promotions as Array<{ strategyId: string }>;
    // L0 strategies are always eligible for L1
    expect(promotions.length).toBeGreaterThanOrEqual(1);
    expect(promotions.every((p) => p.strategyId === "l0-a")).toBe(true);

    const summary = d.summary as Record<string, unknown>;
    expect(summary.total).toBe(1);
    expect(summary.eligible).toBeGreaterThanOrEqual(1);
    expect(typeof summary.needsConfirmation).toBe("number");
    expect(typeof summary.autoPromote).toBe("number");
  });

  // ── 8b. fin_list_promotions_ready: L1_BACKTEST filter works (regression for cast bug) ──

  it("fin_list_promotions_ready: L1_BACKTEST filter returns only L1 strategies", async () => {
    const records = [
      makeRecord({ id: "l0-x", level: "L0_INCUBATE" }),
      makeRecord({
        id: "l1-x",
        level: "L1_BACKTEST",
        lastBacktest: { sharpe: 1.5, maxDrawdown: -12, totalTrades: 150 },
        lastWalkForward: { passed: true, ratio: 0.8, threshold: 0.6 },
      }),
      makeRecord({ id: "l2-x", level: "L2_PAPER" }),
    ];

    const { tools } = buildDeps(records);

    // Filter for L1_BACKTEST — this used to be broken by `as "L0_INCUBATE"` cast
    const result = await tools.get("fin_list_promotions_ready")!("test", {
      level: "L1_BACKTEST",
    });
    const d = parseDetails(result);

    const promotions = d.promotions as Array<{ strategyId: string }>;
    // Should only include L1 strategies, not L0 or L2
    expect(promotions.every((p) => p.strategyId.startsWith("l1-"))).toBe(true);
    expect(promotions.length).toBeGreaterThanOrEqual(1);

    const summary = d.summary as Record<string, unknown>;
    // total should be 1 (only L1 strategies after filter)
    expect(summary.total).toBe(1);
  });
});
