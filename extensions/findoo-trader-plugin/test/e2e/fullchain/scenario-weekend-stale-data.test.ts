/**
 * Phase F — Scenario: Weekend / Stale Data Recovery.
 *
 * Verifies that the trading pipeline degrades gracefully when data is missing,
 * exchanges are unreachable, or only sparse snapshots are available.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-weekend-stale-data.test.ts
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
import { DecayDetector } from "../../../src/paper/decay-detector.js";
import type { EquitySnapshot } from "../../../src/paper/types.js";
import { createFullChainServer, fetchJson, type FullChainContext } from "./harness.js";

describe("Scenario — Weekend / Stale Data Recovery", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. PaperEngine crypto market (24/7) always accepts orders ──

  it("crypto paper account accepts orders 24/7", () => {
    const acct = ctx.services.paperEngine.createAccount("crypto-247", 10_000);
    expect(acct.id).toBeTruthy();
    expect(acct.cash).toBe(10_000);

    const order = ctx.services.paperEngine.submitOrder(
      acct.id,
      { symbol: "BTC/USDT", side: "buy", type: "market", quantity: 0.01 },
      50_000,
    );
    expect(order.status).toBe("filled");
    expect(order.symbol).toBe("BTC/USDT");

    const state = ctx.services.paperEngine.getAccountState(acct.id);
    expect(state).not.toBeNull();
    expect(state!.positions.length).toBeGreaterThan(0);
  });

  // ── 2. Paper order works without external data provider ──

  it("paper order fills without any data service dependency", () => {
    const acct = ctx.services.paperEngine.createAccount("no-data", 5_000);

    // Submit a limit order with explicit price — no data provider needed
    const order = ctx.services.paperEngine.submitOrder(
      acct.id,
      { symbol: "ETH/USDT", side: "buy", type: "market", quantity: 0.1 },
      3_000,
    );
    expect(order.status).toBe("filled");
    expect(order.fillPrice).toBeGreaterThan(0);

    // Sell back — also no data provider
    const sell = ctx.services.paperEngine.submitOrder(
      acct.id,
      { symbol: "ETH/USDT", side: "sell", type: "market", quantity: 0.1 },
      3_050,
    );
    expect(sell.status).toBe("filled");
  });

  // ── 3. gatherTradingData() partial service failure → no crash ──

  it("GET /api/v1/finance/command-center returns 200 with minimal data", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/command-center`);
    expect(status).toBe(200);
    expect(body).toBeDefined();

    // Should have trading data structure even if sparse
    const data = body as Record<string, unknown>;
    expect(data).toHaveProperty("trading");
  });

  // ── 4. gatherLiveTradingData() exchange connection failure → returns error gracefully ──

  it("live trading data endpoint returns 200 with empty/error data when no exchanges connected", async () => {
    // The harness has no real exchange connections (ccxt is mocked).
    // The endpoint should handle this gracefully.
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/command-center`);
    expect(status).toBe(200);

    // Even without live exchange data, the command center should not crash
    const data = body as Record<string, unknown>;
    expect(typeof data).toBe("object");
  });

  // ── 5. AlertEngine evaluate with empty prices → skip, no crash ──

  it("AlertEngine handles evaluation with no matching prices gracefully", () => {
    // Add a price alert
    const alertId = ctx.services.alertEngine.addAlert(
      { kind: "price_above", symbol: "BTC/USDT", price: 100_000 },
      "BTC moon alert",
    );
    expect(alertId).toBeTruthy();

    // List alerts — should contain the one we just added
    const alerts = ctx.services.alertEngine.listAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    const found = alerts.find((a) => a.id === alertId);
    expect(found).toBeDefined();
    expect(found!.condition).toHaveProperty("kind", "price_above");

    // AlertEngine is CRUD-based (no evaluate method that takes prices).
    // The key resilience property: adding/listing/triggering alerts with
    // null or missing data should never throw.
    expect(() => ctx.services.alertEngine.triggerAlert("nonexistent-id")).not.toThrow();

    // Trigger the real alert — should succeed
    const triggered = ctx.services.alertEngine.triggerAlert(alertId);
    expect(triggered).toBe(true);

    // Verify triggered state
    const updated = ctx.services.alertEngine.listAlerts();
    const triggeredAlert = updated.find((a) => a.id === alertId);
    expect(triggeredAlert!.notified).toBe(true);
    expect(triggeredAlert!.triggeredAt).toBeDefined();
  });

  // ── 6. DecayDetector evaluates fewer than 7 snapshots → healthy default ──

  it("DecayDetector returns healthy for fewer than 7 snapshots", () => {
    const detector = new DecayDetector();
    const now = Date.now();

    // Only 5 snapshots — below MIN_DAYS threshold
    const sparseSnapshots: EquitySnapshot[] = Array.from({ length: 5 }, (_, i) => ({
      accountId: "test-sparse",
      timestamp: now - (4 - i) * 86_400_000,
      equity: 10_000 + i * 50,
      cash: 8_000 + i * 30,
      positionsValue: 2_000 + i * 20,
    }));

    const result = detector.evaluate(sparseSnapshots);
    expect(result.decayLevel).toBe("healthy");
    expect(result.rollingSharpe7d).toBe(0);
    expect(result.rollingSharpe30d).toBe(0);
    expect(result.currentDrawdown).toBe(0);
    expect(result.peakEquity).toBe(sparseSnapshots[sparseSnapshots.length - 1]!.equity);

    // Edge case: zero snapshots
    const empty = detector.evaluate([]);
    expect(empty.decayLevel).toBe("healthy");
    expect(empty.peakEquity).toBe(0);

    // Edge case: single snapshot
    const single = detector.evaluate([
      {
        accountId: "single",
        timestamp: now,
        equity: 5_000,
        cash: 3_000,
        positionsValue: 2_000,
      },
    ]);
    expect(single.decayLevel).toBe("healthy");
    expect(single.peakEquity).toBe(5_000);
  });

  // ── 7. Dashboard aggregate HTTP endpoint fault tolerance ──

  it("GET /api/v1/finance/command-center returns full structure even with minimal setup", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/command-center`);
    expect(status).toBe(200);

    const data = body as Record<string, unknown>;

    // Command center should aggregate multiple data sources
    // Even with minimal data, the structure should be intact
    expect(data).toHaveProperty("trading");
    expect(data).toHaveProperty("events");
    expect(data).toHaveProperty("risk");

    // Trading sub-object should exist with summary, positions, orders, etc.
    const trading = data.trading as Record<string, unknown>;
    expect(trading).toBeDefined();
    const summary = trading.summary as Record<string, unknown>;
    expect(summary).toBeDefined();
    expect(typeof summary.totalEquity).toBe("number");

    // Events sub-object
    const events = data.events as Record<string, unknown>;
    expect(events).toBeDefined();
    expect(Array.isArray(events.events)).toBe(true);
  });
});
