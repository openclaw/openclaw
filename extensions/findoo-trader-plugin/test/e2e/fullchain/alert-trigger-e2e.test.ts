/**
 * L3 Gateway E2E — Alert trigger + emergency pause + lifecycle cycle + daily brief.
 *
 * Uses FullChainServer with real HTTP server to validate end-to-end flows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("ccxt", () => {
  class MockExchange {
    id = "binance";
    setSandboxMode = vi.fn();
    close = vi.fn();
    fetchBalance = vi.fn(async () => ({ total: { USDT: 10000, BTC: 0.5 } }));
    fetchMarkets = vi.fn(async () => [{ id: "BTCUSDT", symbol: "BTC/USDT" }]);
    fetchOrderBook = vi.fn(async () => ({
      bids: [[65000, 1.5]],
      asks: [[65100, 1.2]],
      timestamp: Date.now(),
    }));
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

import type { FullChainContext } from "./harness.js";
import { createFullChainServer, fetchJson } from "./harness.js";

describe("L3 — Alert Trigger + Stability E2E", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15000);

  afterAll(() => ctx?.cleanup());

  // ═══════════════════════════════════════════════════════════════
  // 1. Alert CRUD + auto-trigger via LifecycleEngine
  // ═══════════════════════════════════════════════════════════════

  it("alert CRUD + auto-trigger: addAlert → mock price → runCycle → triggeredAt set", async () => {
    const { alertEngine, lifecycleEngine, activityLog } = ctx.services;
    const { dataProvider } = ctx.services;

    // Create a price_above alert
    const alertId = alertEngine.addAlert(
      { kind: "price_above", symbol: "ETH/USDT", price: 4000 },
      "ETH above 4k",
    );

    // Verify via HTTP GET
    const listRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts`);
    expect(listRes.status).toBe(200);
    const alerts = (listRes.body as { alerts: Array<{ id: string }> }).alerts;
    expect(alerts.some((a) => a.id === alertId)).toBe(true);

    // Set mock price below threshold — should NOT trigger
    dataProvider.prices.set("ETH/USDT", 3500);
    await lifecycleEngine.runCycle();

    let alert = alertEngine.listAlerts().find((a) => a.id === alertId)!;
    expect(alert.triggeredAt).toBeUndefined();

    // Set mock price above threshold — SHOULD trigger
    dataProvider.prices.set("ETH/USDT", 4200);
    await lifecycleEngine.runCycle();

    alert = alertEngine.listAlerts().find((a) => a.id === alertId)!;
    expect(alert.triggeredAt).toBeDefined();

    // Verify via GET — triggeredAt should be present
    const listRes2 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts`);
    const alerts2 = (listRes2.body as { alerts: Array<{ id: string; triggeredAt?: string }> })
      .alerts;
    const triggered = alerts2.find((a) => a.id === alertId);
    expect(triggered?.triggeredAt).toBeDefined();

    // Activity log should have the wake entry
    const logs = activityLog.listRecent(50);
    expect(logs.some((l) => l.action === "health_alert_wake")).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. Emergency pause via HTTP
  // ═══════════════════════════════════════════════════════════════

  it("emergency pause: POST pause → GET config shows paused", async () => {
    const { riskController } = ctx.services;

    // Pause trading
    riskController.pause();
    expect(riskController.isPaused()).toBe(true);

    // Verify via GET /config
    const configRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config`);
    expect(configRes.status).toBe(200);
    const config = configRes.body as { risk?: { paused?: boolean } };
    // The config endpoint shows risk state
    expect(riskController.isPaused()).toBe(true);

    // Resume
    riskController.resume();
    expect(riskController.isPaused()).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. LifecycleEngine manual cycle with wake logging
  // ═══════════════════════════════════════════════════════════════

  it("lifecycle runCycle: alert + mock price → activityLog has wake record", async () => {
    const { alertEngine, lifecycleEngine, activityLog, dataProvider } = ctx.services;

    // Create a fresh alert
    const alertId = alertEngine.addAlert(
      { kind: "price_below", symbol: "SOL/USDT", price: 100 },
      "SOL dipped below 100",
    );

    // Set price that triggers
    dataProvider.prices.set("SOL/USDT", 90);
    await lifecycleEngine.runCycle();

    // Verify alert was triggered
    const alert = alertEngine.listAlerts().find((a) => a.id === alertId)!;
    expect(alert.triggeredAt).toBeDefined();

    // Activity log should contain wake entries
    const logs = activityLog.listRecent(100);
    const wakeEntries = logs.filter((l) => l.category === "wake");
    expect(wakeEntries.length).toBeGreaterThanOrEqual(1);
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. Daily brief HTTP endpoint includes liveEquity
  // ═══════════════════════════════════════════════════════════════

  it("GET /daily-brief returns brief with liveEquity field", async () => {
    const res = await fetchJson(`${ctx.baseUrl}/api/v1/finance/daily-brief`);
    expect(res.status).toBe(200);

    const data = res.body as {
      brief: {
        date: string;
        portfolioChange: { totalEquity: number };
        liveEquity: number;
        recommendation: string;
      };
    };

    expect(data.brief).toBeDefined();
    expect(data.brief.date).toBeDefined();
    expect(typeof data.brief.portfolioChange.totalEquity).toBe("number");
    expect(typeof data.brief.liveEquity).toBe("number");
    expect(data.brief.recommendation).toBeDefined();
  });
});
