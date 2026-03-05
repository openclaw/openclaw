/**
 * L2/L3 Integration — 5 Gap 补齐验证
 *
 * Tests all 5 gaps working together with real components in the fullchain harness:
 *   Gap 1: HEARTBEAT.md template injection into prompt context
 *   Gap 2: Wake confirmation tracking (pending → reconcile → resolved)
 *   Gap 3: L3 circuit breaker via LiveHealthMonitor → LifecycleEngine demotion
 *   Gap 4: Regime detection wiring in PaperScheduler
 *   Gap 5: L3 live reconciler position drift detection
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-5gap-integration.test.ts
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
import { buildFinancialContext } from "../../../src/core/prompt-context.js";
import { LiveHealthMonitor } from "../../../src/execution/live-health-monitor.js";
import { LiveReconciler } from "../../../src/execution/live-reconciler.js";
import { PaperScheduler } from "../../../src/paper/paper-scheduler.js";
import { createFullChainServer, fetchJson, type FullChainContext } from "./harness.js";

describe("L2/L3 — 5 Gap Integration", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ════════════════════════════════════════════════════════════
  // Gap 1: HEARTBEAT.md template loading into prompt context
  // ════════════════════════════════════════════════════════════

  describe("Gap 1 — Heartbeat checklist injection", () => {
    it("buildFinancialContext with real services + checklist produces complete output", () => {
      const context = buildFinancialContext({
        heartbeatChecklist: "## Daily Checklist\n- [ ] Check positions\n- [ ] Review alerts",
        paperEngine: ctx.services.paperEngine,
        strategyRegistry: ctx.services.strategyRegistry,
        riskController: ctx.services.riskController,
        exchangeRegistry: ctx.services.registry,
        eventStore: ctx.services.eventStore,
        lifecycleEngine: ctx.services.lifecycleEngine,
      });

      expect(context).toContain("Financial Context:");
      expect(context).toContain("Financial Heartbeat Checklist:");
      expect(context).toContain("## Daily Checklist");
      expect(context).toContain("- [ ] Check positions");
      // Should also contain standard financial context
      expect(context).toContain("Risk level:");
    });
  });

  // ════════════════════════════════════════════════════════════
  // Gap 2: Wake confirmation (pending → reconcile → resolved)
  // ════════════════════════════════════════════════════════════

  describe("Gap 2 — Wake confirmation with real ActivityLogStore", () => {
    it("wake → reconcile cycle 1 (keep) → reconcile cycle 2 (resolve) → logged", () => {
      const bridge = ctx.services.wakeBridge;

      bridge.onHealthAlert({ accountId: "paper-1", condition: "test_gap2", value: 99 });
      expect(bridge.getPending().length).toBeGreaterThanOrEqual(1);

      // End cycle 1 — was fired this cycle, should keep
      bridge.reconcilePending();
      const stillPending = bridge.getPending().filter((w) => w.contextKey.includes("test_gap2"));
      expect(stillPending.length).toBe(1);

      // Cycle 2 — not re-fired → resolved
      const resolved = bridge.reconcilePending();
      expect(resolved).toBeGreaterThanOrEqual(1);

      // Verify activity log has wake_resolved entry
      const logs = ctx.services.activityLog.listRecent(20, "wake");
      expect(logs.some((l) => l.action === "wake_resolved")).toBe(true);
    });

    it("LifecycleEngine.runCycle() calls reconcilePending (integrated)", async () => {
      const bridge = ctx.services.wakeBridge;

      // Fire a wake event
      bridge.onPromotionReady({ strategyId: "test-promo", from: "L1", to: "L2" });
      const beforeCount = bridge.getPending().length;
      expect(beforeCount).toBeGreaterThanOrEqual(1);

      // Run lifecycle cycle — it should call reconcilePending at the end
      await ctx.services.lifecycleEngine.runCycle();

      // After first cycle, the wake was fired this cycle so it stays
      // After second cycle (without re-fire), it resolves
      await ctx.services.lifecycleEngine.runCycle();

      const afterCount = bridge
        .getPending()
        .filter((w) => w.contextKey.includes("test-promo")).length;
      expect(afterCount).toBe(0);
    });
  });

  // ════════════════════════════════════════════════════════════
  // Gap 3: L3 Circuit Breaker (LiveHealthMonitor)
  // ════════════════════════════════════════════════════════════

  describe("Gap 3 — L3 Circuit Breaker with real stores", () => {
    it("LiveHealthMonitor.check() with no L3 strategies returns healthy", async () => {
      const result = await ctx.services.liveHealthMonitor.check();
      expect(result.circuitBroken).toBe(false);
      expect(result.strategiesAffected).toEqual([]);
    });

    it("standalone LiveHealthMonitor detects loss and emits to real EventStore", async () => {
      // Create a standalone monitor with mocked liveExecutor for controlled testing
      const monitor = new LiveHealthMonitor({
        liveExecutor: {
          fetchBalance: vi.fn(async () => ({
            total: { USDT: 8000 },
            info: { initialCapital: 10000 },
          })),
          cancelOrder: vi.fn(async () => ({})),
        },
        strategyRegistry: {
          list: vi.fn(() => [
            {
              id: "cb-s1",
              name: "CB Test",
              level: "L3_LIVE",
              definition: { symbols: ["BTC/USDT"] },
            },
          ]),
        },
        eventStore: ctx.services.eventStore,
        activityLog: ctx.services.activityLog,
        wakeBridge: ctx.services.wakeBridge,
        thresholds: { maxCumulativeLossPct: 10, alertCooldownMs: 0 },
      });

      const result = await monitor.check();
      expect(result.circuitBroken).toBe(true);
      expect(result.lossPct).toBe(20);

      // Verify events landed in real EventStore
      const events = ctx.services.eventStore.listEvents({ type: "alert_triggered" });
      expect(events.some((e) => e.title.includes("Circuit Breaker"))).toBe(true);

      // Verify activity log has the circuit breaker entry
      const logs = ctx.services.activityLog.listRecent(20, "risk");
      expect(logs.some((l) => l.action === "l3_circuit_breaker")).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════
  // Gap 4: Regime Detection Wiring
  // ════════════════════════════════════════════════════════════

  describe("Gap 4 — Regime detection in PaperScheduler (real components)", () => {
    it("PaperScheduler uses regimeDetectorResolver when provided", async () => {
      const detectFn = vi.fn(() => "bull");

      const scheduler = new PaperScheduler({
        paperEngine: ctx.services.paperEngine as never,
        strategyRegistry: {
          list: vi.fn(() => [
            {
              id: "regime-test",
              name: "Regime Test",
              level: "L2_PAPER",
              definition: {
                symbols: ["BTC/USDT"],
                timeframes: ["1h"],
                markets: ["crypto"],
                onBar: vi.fn((_bar: unknown, ctx: { regime: string }) => {
                  // Capture: regime should be "bull"
                  expect(ctx.regime).toBe("bull");
                  return null;
                }),
              },
            },
          ]),
        },
        dataProvider: {
          getOHLCV: vi.fn(async () => [
            { timestamp: 1, open: 100, high: 110, low: 90, close: 105, volume: 1000 },
          ]),
        },
        regimeDetectorResolver: () => ({ detect: detectFn }),
      });

      await scheduler.tickAll();
      expect(detectFn).toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════
  // Gap 5: L3 Live Reconciler
  // ════════════════════════════════════════════════════════════

  describe("Gap 5 — Live Reconciler with real stores", () => {
    it("LiveReconciler.reconcile() with no L3 strategies returns empty", async () => {
      const results = await ctx.services.liveReconciler.reconcile();
      expect(results).toEqual([]);
    });

    it("standalone LiveReconciler detects drift and logs to real stores", async () => {
      const reconciler = new LiveReconciler({
        liveExecutor: {
          fetchPositions: vi.fn(async () => [{ symbol: "BTC/USDT", contracts: 2.0 }]),
        },
        paperEngine: {
          listAccounts: vi.fn(() => [{ id: "paper-1" }]),
          getAccountState: vi.fn(() => ({
            positions: [{ symbol: "BTC/USDT", quantity: 1.0 }],
          })),
        },
        strategyRegistry: {
          list: vi.fn(() => [
            {
              id: "drift-s1",
              name: "Drift Test",
              level: "L3_LIVE",
              definition: { symbols: ["BTC/USDT"] },
            },
          ]),
        },
        eventStore: ctx.services.eventStore,
        activityLog: ctx.services.activityLog,
        wakeBridge: ctx.services.wakeBridge,
        thresholds: { warningDriftPct: 15, criticalDriftPct: 30, alertCooldownMs: 0 },
      });

      const results = await reconciler.reconcile();
      expect(results.length).toBe(1);
      expect(results[0].severity).toBe("critical");
      expect(results[0].driftPct).toBe(50);

      // Second cycle — consecutive critical
      await reconciler.reconcile();
      expect(reconciler.getConsecutiveCritical("drift-s1")).toBe(2);

      // Verify events landed in real EventStore
      const events = ctx.services.eventStore.listEvents({ type: "alert_triggered" });
      expect(events.some((e) => e.title.includes("Drift"))).toBe(true);

      // Verify activity log
      const logs = ctx.services.activityLog.listRecent(20, "risk");
      expect(logs.some((l) => l.action === "l3_position_drift")).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════
  // Cross-Gap: LifecycleEngine orchestrates all gaps together
  // ════════════════════════════════════════════════════════════

  describe("Cross-Gap — LifecycleEngine full cycle with all 5 gaps", () => {
    it("runCycle with L1 strategy triggers promotion + wake + reconcile flow", async () => {
      // Create a strategy at L1 with passing gates
      const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: "sma-crossover",
          name: "CrossGap Test Strategy",
          symbol: "ETH/USDT",
          timeframe: "4h",
          exchangeId: "binance",
          parameters: { fastPeriod: 10, slowPeriod: 30 },
        }),
      });
      expect(createRes.status).toBe(201);
      const strategyId = (createRes.body as { strategy: { id: string } }).strategy.id;

      // Set up L1 with passing backtest/walkforward
      ctx.services.strategyRegistry.updateLevel(strategyId, "L1_BACKTEST" as never);
      ctx.services.strategyRegistry.updateBacktest(strategyId, {
        strategyId,
        startDate: Date.now() - 86_400_000 * 90,
        endDate: Date.now(),
        initialCapital: 10000,
        finalEquity: 14000,
        totalReturn: 40,
        sharpe: 1.8,
        sortino: 2.5,
        maxDrawdown: -10,
        calmar: 4.0,
        winRate: 0.62,
        profitFactor: 2.1,
        totalTrades: 200,
        trades: [],
        equityCurve: [],
        dailyReturns: [],
      } as never);
      ctx.services.strategyRegistry.updateWalkForward(strategyId, {
        passed: true,
        windows: [],
        combinedTestSharpe: 1.4,
        avgTrainSharpe: 1.8,
        ratio: 0.78,
        threshold: 0.6,
      } as never);

      const beforeCycle = ctx.services.lifecycleEngine.getStats().cycleCount;

      // Run the full lifecycle cycle
      const result = await ctx.services.lifecycleEngine.runCycle();
      expect(result.errors).toBe(0);
      expect(result.promoted).toBeGreaterThanOrEqual(1);

      // Verify strategy promoted
      const updated = ctx.services.strategyRegistry.get(strategyId);
      expect(updated?.level).toBe("L2_PAPER");

      // Verify cycle count incremented
      expect(ctx.services.lifecycleEngine.getStats().cycleCount).toBe(beforeCycle + 1);

      // Verify wake bridge activity was logged
      const wakeLog = ctx.services.activityLog.listRecent(30, "promotion");
      expect(wakeLog.some((l) => l.strategyId === strategyId)).toBe(true);

      // Verify the promotion is visible via Flow JSON API
      const flowRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/flow`);
      expect(flowRes.status).toBe(200);
      const flowData = flowRes.body as { strategies: Array<{ id: string; level: string }> };
      const card = flowData.strategies.find((s) => s.id === strategyId);
      expect(card?.level).toBe("L2_PAPER");
    });
  });
});
