/**
 * L2 Integration Tests — AlertEngine + LifecycleEngine + WakeBridge + RiskController.
 *
 * Uses real SQLite components in a tmpdir, no HTTP server.
 * Validates cross-component data flow for alert, pause, circuit breaker, and brief scenarios.
 */

vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLogStore } from "../../src/core/activity-log-store.js";
import { AgentEventSqliteStore } from "../../src/core/agent-event-sqlite-store.js";
import { AgentWakeBridge } from "../../src/core/agent-wake-bridge.js";
import { AlertEngine } from "../../src/core/alert-engine.js";
import { DailyBriefScheduler } from "../../src/core/daily-brief-scheduler.js";
import { LifecycleEngine } from "../../src/core/lifecycle-engine.js";
import { RiskController } from "../../src/core/risk-controller.js";
import { FundManager } from "../../src/fund/fund-manager.js";
import { PaperEngine } from "../../src/paper/paper-engine.js";
import { PaperStore } from "../../src/paper/paper-store.js";
import { StrategyRegistry } from "../../src/strategy/strategy-registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "alert-lc-int-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
// A: AlertEngine → LifecycleEngine alert auto-trigger
// ═══════════════════════════════════════════════════════════════

describe("A: AlertEngine → LifecycleEngine auto-trigger", () => {
  it("addAlert → runCycle with matching price → alert triggered + wake enqueued", async () => {
    const eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
    const activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));
    const alertEngine = new AlertEngine(join(tmpDir, "alerts.sqlite"));
    const strategyRegistry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const fundManager = new FundManager(join(tmpDir, "fund.json"), {
      totalCapital: 100000,
      cashReservePct: 30,
      maxSingleStrategyPct: 30,
      maxTotalExposurePct: 70,
      rebalanceFrequency: "weekly",
    });
    fundManager.markDayStart(100000);

    const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });

    const enqueued: string[] = [];
    const wakeBridge = new AgentWakeBridge({
      enqueueSystemEvent: (text) => enqueued.push(text),
      sessionKeyResolver: () => "test-session",
      activityLog,
      dbPath: join(tmpDir, "wake.sqlite"),
    });

    // Mock data provider with controllable prices
    const prices = new Map<string, number>();
    const dataProvider = {
      async getTicker(symbol: string) {
        const price = prices.get(symbol);
        return price != null ? { close: price } : null;
      },
    };

    const engine = new LifecycleEngine(
      {
        strategyRegistry: strategyRegistry as never,
        fundManagerResolver: () => fundManager as never,
        paperEngine: paperEngine as never,
        eventStore,
        activityLog,
        wakeBridge,
        alertEngine,
        dataProvider,
      },
      300_000,
    );

    // Add a price_above alert for BTC at 70000
    const alertId = alertEngine.addAlert(
      { kind: "price_above", symbol: "BTC/USDT", price: 70000 },
      "BTC broke 70k!",
    );

    // Set price below threshold — should NOT trigger
    prices.set("BTC/USDT", 65000);
    await engine.runCycle();

    const alertsAfterFirst = alertEngine.listAlerts();
    const alert1 = alertsAfterFirst.find((a) => a.id === alertId)!;
    expect(alert1.triggeredAt).toBeUndefined();

    // Set price above threshold — should trigger
    prices.set("BTC/USDT", 72000);
    await engine.runCycle();

    const alertsAfterSecond = alertEngine.listAlerts();
    const alert2 = alertsAfterSecond.find((a) => a.id === alertId)!;
    expect(alert2.triggeredAt).toBeDefined();

    // Wake bridge should have received health alert wake
    const wakeTexts = enqueued.filter((t) => t.includes("alert_triggered"));
    expect(wakeTexts.length).toBeGreaterThanOrEqual(1);

    // Activity log should have the wake entry
    const logs = activityLog.listRecent(50);
    const wakeLogs = logs.filter((l) => l.action === "health_alert_wake");
    expect(wakeLogs.length).toBeGreaterThanOrEqual(1);

    engine.stop();
    alertEngine.close();
    eventStore.close();
    activityLog.close();
    paperStore.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// B: Wake persistence round-trip (SQLite)
// ═══════════════════════════════════════════════════════════════

describe("B: Wake persistence round-trip", () => {
  it("no session → 3 wakes persisted → set session → drain → 3 delivered", () => {
    const activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));
    const dbPath = join(tmpDir, "wake.sqlite");
    const enqueued: string[] = [];
    let sessionKey: string | undefined;

    const bridge = new AgentWakeBridge({
      enqueueSystemEvent: (text) => enqueued.push(text),
      sessionKeyResolver: () => sessionKey,
      activityLog,
      dbPath,
    });

    // Fire 3 wakes with no session
    bridge.onHealthAlert({ accountId: "a1", condition: "dd", value: 5 });
    bridge.onHealthAlert({ accountId: "a2", condition: "loss", value: 3 });
    bridge.onDailyBriefReady({ totalPnl: 100, strategyCount: 5 });

    expect(enqueued).toHaveLength(0);
    expect(bridge.getPending()).toHaveLength(3);

    // Set session and drain
    sessionKey = "main";
    const delivered = bridge.drainUndelivered();

    expect(delivered).toBe(3);
    expect(enqueued).toHaveLength(3);

    activityLog.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// C: Emergency pause full chain
// ═══════════════════════════════════════════════════════════════

describe("C: Emergency pause full chain", () => {
  it("pause → evaluate rejects → resume → evaluate allows → events recorded", () => {
    const eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
    const riskController = new RiskController({
      enabled: true,
      maxAutoTradeUsd: 100,
      confirmThresholdUsd: 1000,
      maxDailyLossUsd: 5000,
      maxPositionPct: 20,
      maxLeverage: 10,
    });

    // Normal state — small trade auto-approved
    const eval1 = riskController.evaluate(
      { symbol: "BTC/USDT", side: "buy", type: "market", quantity: 0.001 },
      50,
    );
    expect(eval1.tier).toBe("auto");

    // Pause trading
    riskController.pause();
    expect(riskController.isPaused()).toBe(true);

    // Paused — all trades rejected
    const eval2 = riskController.evaluate(
      { symbol: "BTC/USDT", side: "buy", type: "market", quantity: 0.001 },
      50,
    );
    expect(eval2.tier).toBe("reject");
    expect(eval2.reason).toContain("paused");

    // Resume trading
    riskController.resume();
    expect(riskController.isPaused()).toBe(false);

    // Back to normal
    const eval3 = riskController.evaluate(
      { symbol: "BTC/USDT", side: "buy", type: "market", quantity: 0.001 },
      50,
    );
    expect(eval3.tier).toBe("auto");

    // Record the pause/resume events
    eventStore.addEvent({
      type: "system",
      title: "Trading Paused",
      detail: "Emergency pause activated",
      status: "completed",
    });
    eventStore.addEvent({
      type: "system",
      title: "Trading Resumed",
      detail: "Emergency pause deactivated",
      status: "completed",
    });

    const events = eventStore.listEvents();
    expect(events.length).toBe(2);
    expect(events.some((e) => e.title === "Trading Paused")).toBe(true);
    expect(events.some((e) => e.title === "Trading Resumed")).toBe(true);

    eventStore.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// D: Circuit breaker auto-pause
// ═══════════════════════════════════════════════════════════════

describe("D: Circuit breaker auto-pause (LiveHealthMonitor)", () => {
  it("15% loss → check() → circuitBroken + riskController paused + cancelAll called", async () => {
    const { LiveHealthMonitor } = await import("../../src/execution/live-health-monitor.js");

    const eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
    const activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));
    const riskController = new RiskController({
      enabled: true,
      maxAutoTradeUsd: 100,
      confirmThresholdUsd: 1000,
      maxDailyLossUsd: 5000,
      maxPositionPct: 20,
      maxLeverage: 10,
    });

    let cancelAllCalled = false;
    const mockLiveExecutor = {
      async fetchBalance() {
        // 15% loss: initial 10000, current 8500
        return {
          total: { USDT: 8500 },
          info: { initialCapital: 10000, totalEquity: 8500 },
        };
      },
      async cancelOrder() {
        return {};
      },
      async cancelAllOpenOrders() {
        cancelAllCalled = true;
        return { cancelled: 2, errors: 0 };
      },
    };

    const mockStrategyRegistry = {
      list(filter?: { level?: string }) {
        return [
          {
            id: "strat-1",
            name: "Test Strategy",
            level: "L3_LIVE",
            definition: { symbols: ["BTC/USDT"] },
          },
        ];
      },
    };

    const monitor = new LiveHealthMonitor({
      liveExecutor: mockLiveExecutor,
      strategyRegistry: mockStrategyRegistry,
      eventStore,
      activityLog,
      riskController,
      thresholds: { maxCumulativeLossPct: 10, alertCooldownMs: 0 },
    });

    const result = await monitor.check();

    expect(result.circuitBroken).toBe(true);
    expect(result.lossPct).toBe(15);
    expect(result.strategiesAffected).toContain("strat-1");
    expect(riskController.isPaused()).toBe(true);
    expect(cancelAllCalled).toBe(true);

    // Verify events were recorded
    const events = eventStore.listEvents();
    expect(events.some((e) => e.title.includes("Circuit Breaker"))).toBe(true);

    eventStore.close();
    activityLog.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// E: Daily brief with live equity
// ═══════════════════════════════════════════════════════════════

describe("E: Daily brief includes live equity", () => {
  it("mock liveExecutor → generateBrief → liveEquity = 15000", async () => {
    const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
    paperEngine.createAccount("fund-a", 50000);

    const strategyRegistry = new StrategyRegistry(join(tmpDir, "strategies.json"));

    const mockLiveExecutor = {
      async fetchBalance() {
        return { total: { USDT: 15000 } };
      },
    };

    const scheduler = new DailyBriefScheduler({
      paperEngine,
      strategyRegistry,
      liveExecutor: mockLiveExecutor,
    });

    const brief = await scheduler.generateBrief();

    expect(brief.liveEquity).toBe(15000);
    expect(brief.portfolioChange.totalEquity).toBe(50000);

    paperStore.close();
  });
});
