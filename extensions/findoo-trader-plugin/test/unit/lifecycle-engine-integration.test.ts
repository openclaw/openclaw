/**
 * L2 Integration Test — LifecycleEngine with real StrategyRegistry + ActivityLogStore.
 *
 * Two test groups:
 * 1. "Real FundManager" — uses actual FundManager + PromotionPipeline gates, no mocks
 * 2. "Mock FundManager" — mocks FundManager to test L2→L3 approval and demotion flows
 *    (these require paper trading data that LifecycleEngine doesn't pass to buildProfiles)
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/unit/lifecycle-engine-integration.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLogStore } from "../../src/core/activity-log-store.js";
import { AgentEventSqliteStore } from "../../src/core/agent-event-sqlite-store.js";
import { LifecycleEngine } from "../../src/core/lifecycle-engine.js";
import { FundManager } from "../../src/fund/fund-manager.js";
import { StrategyRegistry } from "../../src/strategy/strategy-registry.js";

// ── Mock helpers (only fund manager + wake bridge — real stores) ──

function createMockFundManager() {
  return {
    buildProfiles: vi.fn((records: unknown[]) =>
      (records as Array<{ id: string; name: string; level: string }>).map((r) => ({
        id: r.id,
        name: r.name,
        level: r.level,
        fitness: 0.5,
      })),
    ),
    checkPromotion: vi.fn((_profile: { id: string; level: string }) => ({
      strategyId: _profile.id,
      currentLevel: _profile.level,
      eligible: false,
      reasons: [],
      blockers: ["not ready"],
    })),
    checkDemotion: vi.fn((_profile: { id: string; level: string }) => ({
      strategyId: _profile.id,
      currentLevel: _profile.level,
      shouldDemote: false,
      reasons: [],
    })),
  };
}

function createMockWakeBridge() {
  return {
    onHealthAlert: vi.fn(),
    onDailyBriefReady: vi.fn(),
    onSeedBacktestComplete: vi.fn(),
    onPromotionReady: vi.fn(),
    onApprovalNeeded: vi.fn(),
  };
}

// ── Test data: backtest/walkForward that satisfies real L1→L2 gates ──
// L1→L2 gates: sharpe ≥ 1.0, |maxDrawdown| ≤ 25%, totalTrades ≥ 100, walkForward.passed
const PASSING_BACKTEST = {
  strategyId: "test",
  startDate: Date.now() - 86_400_000 * 90,
  endDate: Date.now(),
  initialCapital: 10000,
  finalEquity: 13500,
  totalReturn: 35,
  sharpe: 1.5,
  sortino: 2.0,
  maxDrawdown: -12, // -12% (stored as negative percentage)
  calmar: 2.9,
  winRate: 0.58,
  profitFactor: 1.8,
  totalTrades: 150,
  trades: [],
  equityCurve: [],
  dailyReturns: [],
};

const PASSING_WALKFORWARD = {
  passed: true,
  windows: [],
  combinedTestSharpe: 1.2,
  avgTrainSharpe: 1.5,
  ratio: 0.8,
  threshold: 0.6,
};

const FUND_CONFIG = {
  totalCapital: 100000,
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "weekly" as const,
};

// ═══════════════════════════════════════════════════════════════
//  Real FundManager — tests actual PromotionPipeline gates
// ═══════════════════════════════════════════════════════════════

describe("L2 Integration — Real FundManager + PromotionPipeline", () => {
  let tmpDir: string;
  let activityLog: ActivityLogStore;
  let eventStore: AgentEventSqliteStore;
  let registry: StrategyRegistry;
  let realFundManager: FundManager;
  let wakeBridge: ReturnType<typeof createMockWakeBridge>;
  let engine: LifecycleEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-l2-real-"));
    activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));
    eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
    registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    realFundManager = new FundManager(join(tmpDir, "fund-state.json"), FUND_CONFIG);
    wakeBridge = createMockWakeBridge();

    engine = new LifecycleEngine(
      {
        strategyRegistry: registry as never,
        fundManagerResolver: () => realFundManager as never,
        paperEngine: { listAccounts: () => [], getAccountState: () => null },
        eventStore,
        activityLog,
        wakeBridge: wakeBridge as never,
      },
      60_000,
    );
  });

  afterEach(() => {
    engine.stop();
    activityLog.close();
    eventStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("L1→L2 auto-promotes when real gates pass (sharpe/DD/trades/walkForward)", async () => {
    // Create strategy with data that satisfies all L1→L2 gates
    const record = registry.create({
      id: "real-s1",
      name: "Real Gate Strategy",
      version: 1,
      symbols: ["BTC/USDT"],
      timeframes: ["1h"],
      markets: ["crypto"],
      templateId: "sma-crossover",
      parameters: { fastPeriod: 10, slowPeriod: 30 },
    });
    registry.updateLevel(record.id, "L1_BACKTEST");
    registry.updateBacktest(record.id, { ...PASSING_BACKTEST, strategyId: record.id } as never);
    registry.updateWalkForward(record.id, PASSING_WALKFORWARD as never);

    const result = await engine.runCycle();
    expect(result.promoted).toBe(1);

    // Real registry should persist the change
    const updated = registry.get("real-s1");
    expect(updated?.level).toBe("L2_PAPER");

    // Real activityLog should record the promotion with gate reasons
    const logs = activityLog.listRecent(10, "promotion");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]!.strategyId).toBe("real-s1");
    expect(logs[0]!.detail).toContain("L1_BACKTEST");
    expect(logs[0]!.detail).toContain("L2_PAPER");
    // The detail should include reasons from real PromotionPipeline
    expect(logs[0]!.detail).toContain("Sharpe");
  });

  it("L1→L2 blocked when real gates fail (insufficient trades)", async () => {
    const record = registry.create({
      id: "real-s2",
      name: "Low Trade Strategy",
      version: 1,
      symbols: ["ETH/USDT"],
      timeframes: ["4h"],
      markets: ["crypto"],
      templateId: "sma-crossover",
      parameters: {},
    });
    registry.updateLevel(record.id, "L1_BACKTEST");
    // Only 50 trades — gate requires ≥ 100
    registry.updateBacktest(record.id, {
      ...PASSING_BACKTEST,
      strategyId: record.id,
      totalTrades: 50,
    } as never);
    registry.updateWalkForward(record.id, PASSING_WALKFORWARD as never);

    const result = await engine.runCycle();
    expect(result.promoted).toBe(0);

    // Strategy should stay at L1
    expect(registry.get("real-s2")?.level).toBe("L1_BACKTEST");
  });

  it("L1→L2 blocked when walk-forward fails", async () => {
    const record = registry.create({
      id: "real-s3",
      name: "Failed WF Strategy",
      version: 1,
      symbols: ["SOL/USDT"],
      timeframes: ["1h"],
      markets: ["crypto"],
      templateId: "sma-crossover",
      parameters: {},
    });
    registry.updateLevel(record.id, "L1_BACKTEST");
    registry.updateBacktest(record.id, { ...PASSING_BACKTEST, strategyId: record.id } as never);
    registry.updateWalkForward(record.id, {
      ...PASSING_WALKFORWARD,
      passed: false,
      ratio: 0.3,
    } as never);

    const result = await engine.runCycle();
    expect(result.promoted).toBe(0);
    expect(registry.get("real-s3")?.level).toBe("L1_BACKTEST");
  });
});

// ═══════════════════════════════════════════════════════════════
//  Mock FundManager — tests approval/demotion flows
// ═══════════════════════════════════════════════════════════════

// ── Tests ────────────────────────────────────────────────────

describe("L2 Integration — LifecycleEngine + Real Stores", () => {
  let tmpDir: string;
  let activityLog: ActivityLogStore;
  let eventStore: AgentEventSqliteStore;
  let registry: StrategyRegistry;
  let fundManager: ReturnType<typeof createMockFundManager>;
  let wakeBridge: ReturnType<typeof createMockWakeBridge>;
  let engine: LifecycleEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-l2-"));
    activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));
    eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
    registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    fundManager = createMockFundManager();
    wakeBridge = createMockWakeBridge();

    engine = new LifecycleEngine(
      {
        strategyRegistry: registry as never,
        fundManagerResolver: () => fundManager,
        paperEngine: { listAccounts: () => [], getAccountState: () => null },
        eventStore,
        activityLog,
        wakeBridge: wakeBridge as never,
      },
      60_000,
    );
  });

  afterEach(() => {
    engine.stop();
    activityLog.close();
    eventStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("L1→L2 auto-promotion persists in real StrategyRegistry + ActivityLogStore", async () => {
    // Create a real strategy at L1
    const record = registry.create({
      id: "int-s1",
      name: "Integration Strategy",
      version: 1,
      symbols: ["BTC/USDT"],
      timeframes: ["1h"],
      markets: ["crypto"],
      templateId: "sma-crossover",
      parameters: { fastPeriod: 10, slowPeriod: 30 },
    });
    registry.updateLevel(record.id, "L1_BACKTEST");
    registry.updateBacktest(record.id, {
      sharpe: 1.8,
      maxDrawdown: -0.08,
      totalTrades: 50,
      winRate: 0.6,
      profitFactor: 2.1,
      expectancy: 0.02,
      annualReturn: 0.25,
    });
    registry.updateWalkForward(record.id, {
      passed: true,
      ratio: 0.85,
      threshold: 0.6,
    });

    // Mock fundManager to signal promotion eligibility for L1→L2
    fundManager.checkPromotion.mockImplementation((profile: { id: string; level: string }) => ({
      strategyId: profile.id,
      currentLevel: profile.level,
      eligible: profile.level === "L1_BACKTEST",
      targetLevel: profile.level === "L1_BACKTEST" ? "L2_PAPER" : undefined,
      reasons: ["Backtest passed", "Walk-forward confirmed"],
      blockers: [],
    }));

    const result = await engine.runCycle();
    expect(result.promoted).toBe(1);

    // Verify real registry persisted the level change
    const updated = registry.get("int-s1");
    expect(updated?.level).toBe("L2_PAPER");

    // Verify real activityLog recorded the promotion
    const logs = activityLog.listRecent(10, "promotion");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]!.strategyId).toBe("int-s1");
    expect(logs[0]!.detail).toContain("L1_BACKTEST");
    expect(logs[0]!.detail).toContain("L2_PAPER");
  });

  it("L2→L3 requires manual approval and does not auto-promote", async () => {
    const record = registry.create({
      id: "int-s2",
      name: "Mature Strategy",
      version: 1,
      symbols: ["ETH/USDT"],
      timeframes: ["4h"],
      markets: ["crypto"],
      templateId: "rsi-reversal",
      parameters: { period: 14 },
    });
    registry.updateLevel(record.id, "L2_PAPER");

    fundManager.checkPromotion.mockImplementation((profile: { id: string; level: string }) => ({
      strategyId: profile.id,
      currentLevel: profile.level,
      eligible: profile.level === "L2_PAPER",
      targetLevel: profile.level === "L2_PAPER" ? "L3_LIVE" : undefined,
      needsUserConfirmation: profile.level === "L2_PAPER",
      reasons: ["30d paper OK"],
      blockers: [],
    }));

    const result = await engine.runCycle();
    expect(result.approvalsSent).toBe(1);
    expect(result.promoted).toBe(0);

    // Strategy should still be L2_PAPER — NOT auto-promoted
    expect(registry.get("int-s2")?.level).toBe("L2_PAPER");

    // Event store should have a pending approval event
    const events = eventStore.listEvents({ type: "trade_pending" });
    expect(events.length).toBe(1);
    expect(events[0]!.title).toContain("Mature Strategy");

    // Now handle approval manually
    const ok = engine.handleApproval("int-s2");
    expect(ok).toBe(true);

    // Now strategy should be L3_LIVE
    expect(registry.get("int-s2")?.level).toBe("L3_LIVE");

    // Activity log should have both approval request and approved entries
    const approvalLogs = activityLog.listRecent(20, "approval");
    expect(approvalLogs.some((l) => l.action === "l3_approval_requested")).toBe(true);
    expect(approvalLogs.some((l) => l.action === "l3_promotion_approved")).toBe(true);
  });

  it("demotion changes level and records activity", async () => {
    const record = registry.create({
      id: "int-s3",
      name: "Struggling Strategy",
      version: 1,
      symbols: ["SOL/USDT"],
      timeframes: ["1h"],
      markets: ["crypto"],
      templateId: "momentum",
      parameters: {},
    });
    registry.updateLevel(record.id, "L3_LIVE");

    fundManager.checkDemotion.mockImplementation((profile: { id: string; level: string }) => ({
      strategyId: profile.id,
      currentLevel: profile.level,
      shouldDemote: profile.level === "L3_LIVE",
      targetLevel: "L2_PAPER",
      reasons: ["7d Sharpe below threshold"],
    }));

    const result = await engine.runCycle();
    expect(result.demoted).toBe(1);

    expect(registry.get("int-s3")?.level).toBe("L2_PAPER");

    const logs = activityLog.listRecent(10, "demotion");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]!.strategyId).toBe("int-s3");
  });

  it("engine stats accumulate across cycles", async () => {
    registry.create({
      id: "int-s4",
      name: "Cycling Strategy",
      version: 1,
      symbols: ["BTC/USDT"],
      timeframes: ["1h"],
      markets: ["crypto"],
      templateId: "sma-crossover",
      parameters: {},
    });
    registry.updateLevel("int-s4", "L1_BACKTEST");

    fundManager.checkPromotion.mockReturnValue({
      strategyId: "int-s4",
      currentLevel: "L1_BACKTEST",
      eligible: true,
      targetLevel: "L2_PAPER",
      reasons: ["Passed"],
      blockers: [],
    });

    await engine.runCycle();
    await engine.runCycle();

    const stats = engine.getStats();
    expect(stats.cycleCount).toBe(2);
    expect(stats.promotionCount).toBeGreaterThanOrEqual(1);
    expect(stats.lastCycleAt).toBeGreaterThan(0);
  });

  it("rejection removes pending approval and records in activity log", async () => {
    const record = registry.create({
      id: "int-s5",
      name: "Rejected Strategy",
      version: 1,
      symbols: ["DOGE/USDT"],
      timeframes: ["15m"],
      markets: ["crypto"],
      templateId: "scalper",
      parameters: {},
    });
    registry.updateLevel(record.id, "L2_PAPER");

    fundManager.checkPromotion.mockReturnValue({
      strategyId: "int-s5",
      currentLevel: "L2_PAPER",
      eligible: true,
      targetLevel: "L3_LIVE",
      needsUserConfirmation: true,
      reasons: ["Paper metrics OK"],
      blockers: [],
    });

    await engine.runCycle();
    expect(engine.getStats().pendingApprovals).toBe(1);

    const ok = engine.handleRejection("int-s5", "Not confident yet");
    expect(ok).toBe(true);
    expect(engine.getStats().pendingApprovals).toBe(0);

    // Strategy stays L2
    expect(registry.get("int-s5")?.level).toBe("L2_PAPER");

    const logs = activityLog.listRecent(10, "approval");
    expect(logs.some((l) => l.action === "l3_promotion_rejected")).toBe(true);
  });
});
