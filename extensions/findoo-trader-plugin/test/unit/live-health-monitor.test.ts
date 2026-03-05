import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityLogStore } from "../../src/core/activity-log-store.js";
import { AgentEventSqliteStore } from "../../src/core/agent-event-sqlite-store.js";
import { LiveHealthMonitor } from "../../src/execution/live-health-monitor.js";

describe("LiveHealthMonitor (Gap 3)", () => {
  let tmpDir: string;
  let activityLog: ActivityLogStore;
  let eventStore: AgentEventSqliteStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "live-health-test-"));
    activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));
    eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
  });

  afterEach(() => {
    activityLog.close();
    eventStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("triggers circuit breaker on 15% cumulative loss", async () => {
    const wakeBridge = { onHealthAlert: vi.fn() };
    const monitor = new LiveHealthMonitor({
      liveExecutor: {
        fetchBalance: vi.fn(async () => ({
          total: { USDT: 8500 },
          info: { initialCapital: 10000 },
        })),
        cancelOrder: vi.fn(async () => ({})),
      },
      strategyRegistry: {
        list: vi.fn(() => [
          { id: "s1", name: "Live Strat", level: "L3_LIVE", definition: { symbols: ["BTC/USDT"] } },
        ]),
      },
      eventStore,
      activityLog,
      wakeBridge: wakeBridge as any,
      thresholds: { maxCumulativeLossPct: 10, alertCooldownMs: 0 },
    });

    const result = await monitor.check();
    expect(result.circuitBroken).toBe(true);
    expect(result.lossPct).toBe(15);
    expect(result.strategiesAffected).toEqual(["s1"]);

    // Should have emitted alert event
    const events = eventStore.listEvents({ type: "alert_triggered" });
    expect(events.length).toBe(1);
    expect(events[0].title).toContain("Circuit Breaker");

    // Should have woken the agent
    expect(wakeBridge.onHealthAlert).toHaveBeenCalledWith(
      expect.objectContaining({ condition: "l3_circuit_breaker" }),
    );
  });

  it("returns healthy when balance is fine", async () => {
    const monitor = new LiveHealthMonitor({
      liveExecutor: {
        fetchBalance: vi.fn(async () => ({
          total: { USDT: 9800 },
          info: { initialCapital: 10000 },
        })),
        cancelOrder: vi.fn(async () => ({})),
      },
      strategyRegistry: {
        list: vi.fn(() => [
          { id: "s1", name: "Live Strat", level: "L3_LIVE", definition: { symbols: ["BTC/USDT"] } },
        ]),
      },
      eventStore,
      activityLog,
    });

    const result = await monitor.check();
    expect(result.circuitBroken).toBe(false);
    expect(result.lossPct).toBe(2);
  });

  it("returns healthy when no L3 strategies exist", async () => {
    const monitor = new LiveHealthMonitor({
      liveExecutor: {
        fetchBalance: vi.fn(async () => ({})),
        cancelOrder: vi.fn(async () => ({})),
      },
      strategyRegistry: { list: vi.fn(() => []) },
      eventStore,
      activityLog,
    });

    const result = await monitor.check();
    expect(result.circuitBroken).toBe(false);
    expect(result.strategiesAffected).toEqual([]);
  });

  it("handles fetchBalance failure gracefully", async () => {
    const monitor = new LiveHealthMonitor({
      liveExecutor: {
        fetchBalance: vi.fn(async () => {
          throw new Error("connection refused");
        }),
        cancelOrder: vi.fn(async () => ({})),
      },
      strategyRegistry: {
        list: vi.fn(() => [
          { id: "s1", name: "Live Strat", level: "L3_LIVE", definition: { symbols: ["BTC/USDT"] } },
        ]),
      },
      eventStore,
      activityLog,
    });

    const result = await monitor.check();
    expect(result.circuitBroken).toBe(false);
  });
});
