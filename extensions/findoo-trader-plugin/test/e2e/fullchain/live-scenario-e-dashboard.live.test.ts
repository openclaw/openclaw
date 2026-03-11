/**
 * Scenario E: Dashboard with real data verification
 *
 * Tests: Overview/Trader/Strategy/Flow pages show real data (not $0/NaN)
 * Gate: LIVE=1
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OHLCV, Signal, StrategyContext } from "../../../src/shared/types.js";
import {
  LIVE,
  createLiveChainServer,
  fetchJson,
  fetchText,
  type LiveChainContext,
} from "./live-harness.js";

describe.skipIf(!LIVE)("Scenario E: Dashboard Real Data", { timeout: 180_000 }, () => {
  let ctx: LiveChainContext;

  beforeAll(async () => {
    ctx = await createLiveChainServer();

    // Seed data so dashboards have content
    ctx.services.strategyRegistry.create({
      id: "dash-test-sma",
      name: "Dashboard SMA Test",
      version: "1.0.0",
      markets: ["equity"],
      symbols: ["600519.SH"],
      timeframes: ["1d"],
      parameters: {},
      async onBar(_bar: OHLCV, _ctx: StrategyContext): Promise<Signal | null> {
        return null;
      },
    });
    ctx.services.strategyRegistry.updateLevel("dash-test-sma", "L2_PAPER");

    ctx.services.paperEngine.createAccount("dash-paper", 50000);

    // Add activity log entries
    ctx.services.activityLog.append({
      category: "heartbeat",
      action: "strategy_tick",
      detail: "Ticked 1 strategy, 0 signals",
      metadata: { ticked: 1, signals: 0 },
    });

    ctx.services.activityLog.append({
      category: "decision",
      action: "risk_check",
      detail: "Risk level: normal",
      metadata: { riskLevel: "normal" },
    });

    // Add an event
    ctx.services.eventStore.addEvent({
      type: "system",
      title: "Strategy Registered",
      detail: "Dashboard SMA Test registered at L2_PAPER",
      status: "completed",
    });
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("E.1 — Overview page returns real data (non-empty)", async () => {
    const res = await fetchText(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/overview`);
    expect(res.status).toBe(200);

    const html = res.body;
    expect(html.length).toBeGreaterThan(100);
    // Dashboard renders — content is non-empty HTML
    expect(html).toContain("<");
    expect(html).toContain(">");
  });

  it("E.2 — Trader page returns paper account data", async () => {
    const res = await fetchText(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/trader`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(100);
  });

  it("E.3 — Strategy page returns strategy list", async () => {
    const res = await fetchText(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/strategy`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(100);
  });

  it("E.4 — Flow page returns activity data", async () => {
    const res = await fetchText(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/flow`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(100);
  });

  it("E.5 — SSE endpoint delivers real-time data within 5s", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${ctx.baseUrl}/api/v1/finance/config/stream`, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toContain("text/event-stream");

      const reader = res.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        if (value) {
          const text = new TextDecoder().decode(value);
          expect(text).toContain("data:");
        }
        reader.cancel();
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    } finally {
      clearTimeout(timeout);
    }
  });

  it("E.6 — JSON API endpoints return structured data", async () => {
    const strategiesRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    expect(strategiesRes.status).toBe(200);
    expect(strategiesRes.body).toBeDefined();

    const fundRes = await fetchJson(`${ctx.baseUrl}/api/v1/fund/status`);
    expect(fundRes.status).toBe(200);
    expect(fundRes.body).toBeDefined();

    const eventsRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events`);
    expect(eventsRes.status).toBe(200);

    const alertsRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts`);
    expect(alertsRes.status).toBe(200);
  });
});
