/**
 * Trading Stability Tests — covers all 6 phases of the stability hardening:
 * Phase 1: Wake persistence (SQLite + drainUndelivered)
 * Phase 2: Emergency pause/resume
 * Phase 3: Circuit breaker auto-pause
 * Phase 4: AlertEngine auto-trigger
 * Phase 5: Compaction recovery
 * Phase 6: Daily brief live equity
 */

import { mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWakeBridge } from "../../src/core/agent-wake-bridge.js";
import { AlertEngine } from "../../src/core/alert-engine.js";
import { buildFinancialContext } from "../../src/core/prompt-context.js";
import { RiskController } from "../../src/core/risk-controller.js";

function tmpDir(): string {
  const dir = join(tmpdir(), `findoo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Phase 1: Wake Persistence ─────────────────────────────────────

describe("Phase 1: Wake Persistence", () => {
  it("persists wakes to SQLite when session is unavailable, drains on retry", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "wake.sqlite");
    const enqueued: string[] = [];
    let sessionKey: string | undefined;

    const bridge = new AgentWakeBridge({
      enqueueSystemEvent: (text, opts) => {
        enqueued.push(text);
      },
      sessionKeyResolver: () => sessionKey,
      dbPath,
    });

    // Fire 3 wakes with no session — should be persisted but not enqueued
    bridge.onHealthAlert({ accountId: "a1", condition: "dd", value: 5 });
    bridge.onHealthAlert({ accountId: "a2", condition: "loss", value: 3 });
    bridge.onDailyBriefReady({ totalPnl: 100, strategyCount: 5 });

    expect(enqueued).toHaveLength(0);
    expect(bridge.getPending()).toHaveLength(3);

    // Now set session and drain
    sessionKey = "main";
    const delivered = bridge.drainUndelivered();

    expect(delivered).toBe(3);
    expect(enqueued).toHaveLength(3);
  });

  it("marks wakes as delivered on successful enqueue", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "wake.sqlite");
    const enqueued: string[] = [];

    const bridge = new AgentWakeBridge({
      enqueueSystemEvent: (text) => {
        enqueued.push(text);
      },
      sessionKeyResolver: () => "main",
      dbPath,
    });

    bridge.onHealthAlert({ accountId: "a1", condition: "dd", value: 5 });
    expect(enqueued).toHaveLength(1);

    // Drain should find 0 undelivered
    const delivered = bridge.drainUndelivered();
    expect(delivered).toBe(0);
  });

  it("works without dbPath (in-memory only, backward compatible)", () => {
    const enqueued: string[] = [];

    const bridge = new AgentWakeBridge({
      enqueueSystemEvent: (text) => enqueued.push(text),
      sessionKeyResolver: () => "main",
      // no dbPath
    });

    bridge.onHealthAlert({ accountId: "a1", condition: "dd", value: 5 });
    expect(enqueued).toHaveLength(1);
    expect(bridge.drainUndelivered()).toBe(0);
  });
});

// ── Phase 2: Emergency Pause/Resume ───────────────────────────────

describe("Phase 2: Emergency Pause/Resume", () => {
  const baseConfig = {
    enabled: true,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 1000,
    maxDailyLossUsd: 5000,
    maxLeverage: 10,
    maxPositionPct: 25,
  };

  it("rejects all orders when paused", () => {
    const rc = new RiskController(baseConfig);
    rc.pause();

    const result = rc.evaluate(
      { exchange: "binance" as any, symbol: "BTC/USDT", side: "buy", type: "market", amount: 0.01 },
      50,
    );

    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("paused");
  });

  it("resumes trading after resume()", () => {
    const rc = new RiskController(baseConfig);
    rc.pause();
    expect(rc.isPaused()).toBe(true);

    rc.resume();
    expect(rc.isPaused()).toBe(false);

    const result = rc.evaluate(
      { exchange: "binance" as any, symbol: "BTC/USDT", side: "buy", type: "market", amount: 0.01 },
      50,
    );

    expect(result.tier).toBe("auto");
  });
});

// ── Phase 3: Circuit Breaker Auto-Pause ───────────────────────────

describe("Phase 3: Circuit Breaker Auto-Pause", () => {
  it("pauses risk controller when circuit breaks", async () => {
    // Import dynamically to get fresh module
    const { LiveHealthMonitor } = await import("../../src/execution/live-health-monitor.js");
    const { AgentEventSqliteStore } = await import("../../src/core/agent-event-sqlite-store.js");
    const { ActivityLogStore } = await import("../../src/core/activity-log-store.js");

    const dir = tmpDir();
    const eventStore = new AgentEventSqliteStore(join(dir, "events.sqlite"));
    const activityLog = new ActivityLogStore(join(dir, "activity.sqlite"));
    const pauseFn = vi.fn();
    const cancelFn = vi.fn(async () => ({ cancelled: 2, errors: 0 }));

    const monitor = new LiveHealthMonitor({
      liveExecutor: {
        fetchBalance: vi.fn(async () => ({
          total: { USDT: 8500 },
          info: { initialCapital: 10000 },
        })),
        cancelOrder: vi.fn(async () => ({})),
        cancelAllOpenOrders: cancelFn,
      },
      strategyRegistry: {
        list: vi.fn(() => [
          { id: "s1", name: "Test", level: "L3_LIVE", definition: { symbols: ["BTC/USDT"] } },
        ]),
      },
      eventStore,
      activityLog,
      riskController: { pause: pauseFn },
      thresholds: { maxCumulativeLossPct: 10, alertCooldownMs: 0 },
    });

    const result = await monitor.check();
    expect(result.circuitBroken).toBe(true);
    expect(pauseFn).toHaveBeenCalledOnce();
    expect(cancelFn).toHaveBeenCalledOnce();
  });
});

// ── Phase 4: AlertEngine Auto-Trigger ─────────────────────────────

describe("Phase 4: AlertEngine Auto-Trigger", () => {
  it("triggers price_above alert when price exceeds target", () => {
    const dir = tmpDir();
    const engine = new AlertEngine(join(dir, "alerts.sqlite"));

    const id = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });

    const triggered = engine.checkAndTrigger((sym) => {
      if (sym === "BTC/USDT") return 101000;
      return undefined;
    });

    expect(triggered).toEqual([id]);

    // Alert should now be triggered
    const alerts = engine.listAlerts();
    expect(alerts[0].triggeredAt).toBeDefined();

    engine.close();
  });

  it("triggers price_below alert", () => {
    const dir = tmpDir();
    const engine = new AlertEngine(join(dir, "alerts.sqlite"));

    const id = engine.addAlert({ kind: "price_below", symbol: "ETH/USDT", price: 3000 });

    const triggered = engine.checkAndTrigger((sym) => {
      if (sym === "ETH/USDT") return 2900;
      return undefined;
    });

    expect(triggered).toEqual([id]);
    engine.close();
  });

  it("does not trigger when price does not meet condition", () => {
    const dir = tmpDir();
    const engine = new AlertEngine(join(dir, "alerts.sqlite"));

    engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });

    const triggered = engine.checkAndTrigger((sym) => {
      if (sym === "BTC/USDT") return 99000;
      return undefined;
    });

    expect(triggered).toHaveLength(0);
    engine.close();
  });

  it("getActiveAlerts excludes already-triggered alerts", () => {
    const dir = tmpDir();
    const engine = new AlertEngine(join(dir, "alerts.sqlite"));

    const id1 = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });
    engine.addAlert({ kind: "price_below", symbol: "ETH/USDT", price: 3000 });

    engine.triggerAlert(id1);

    const active = engine.getActiveAlerts();
    expect(active).toHaveLength(1);
    expect(active[0].condition.symbol).toBe("ETH/USDT");

    engine.close();
  });
});

// ── Phase 5: Compaction Recovery ──────────────────────────────────

describe("Phase 5: Compaction Recovery", () => {
  it("injects recovery data into financial context and deletes file", () => {
    const dir = tmpDir();
    const recoveryPath = join(dir, "compaction-recovery.json");

    const snapshot = {
      ts: Date.now(),
      equity: { paper: 50000, live: 25000 },
      livePositions: [{ symbol: "BTC/USDT", size: 0.5 }],
      openOrders: [],
      pending: [{ id: "p1" }],
      paused: true,
    };
    writeFileSync(recoveryPath, JSON.stringify(snapshot));

    const context = buildFinancialContext({ recoveryFilePath: recoveryPath });

    expect(context).toContain("COMPACTION RECOVERY");
    expect(context).toContain("$25000");
    expect(context).toContain("$50000");
    expect(context).toContain("BTC/USDT");
    expect(context).toContain("PAUSED");
    expect(context).toContain("Pending approvals: 1");

    // File should be deleted after reading
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it("ignores stale recovery files (>1h)", () => {
    const dir = tmpDir();
    const recoveryPath = join(dir, "compaction-recovery.json");

    const snapshot = {
      ts: Date.now() - 4_000_000, // >1h ago
      equity: { paper: 50000, live: 25000 },
      livePositions: [],
      openOrders: [],
      pending: [],
    };
    writeFileSync(recoveryPath, JSON.stringify(snapshot));

    const context = buildFinancialContext({ recoveryFilePath: recoveryPath });

    expect(context).not.toContain("COMPACTION RECOVERY");
  });

  it("handles missing recovery file gracefully", () => {
    const context = buildFinancialContext({
      recoveryFilePath: "/nonexistent/path/recovery.json",
    });
    // Should not throw, just return empty or normal context
    expect(context).toBeDefined();
  });
});

// ── Phase 6: Daily Brief Live Equity ──────────────────────────────

describe("Phase 6: Daily Brief Live Equity", () => {
  it("includes live equity in brief when liveExecutor is available", async () => {
    const { DailyBriefScheduler } = await import("../../src/core/daily-brief-scheduler.js");

    const scheduler = new DailyBriefScheduler({
      liveExecutor: {
        fetchBalance: vi.fn(async () => ({ total: { USDT: 15000 } })),
      },
      paperEngine: {
        listAccounts: () => [{ id: "a1", name: "Test", equity: 10000 }],
        getAccountState: () => null,
      },
    });

    const brief = await scheduler.generateBrief();
    expect(brief.liveEquity).toBe(15000);
  });

  it("degrades gracefully when exchange is offline", async () => {
    const { DailyBriefScheduler } = await import("../../src/core/daily-brief-scheduler.js");

    const scheduler = new DailyBriefScheduler({
      liveExecutor: {
        fetchBalance: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      },
      paperEngine: {
        listAccounts: () => [{ id: "a1", name: "Test", equity: 10000 }],
        getAccountState: () => null,
      },
    });

    const brief = await scheduler.generateBrief();
    expect(brief.liveEquity).toBe(0);
    expect(brief.portfolioChange.totalEquity).toBe(10000);
  });
});
