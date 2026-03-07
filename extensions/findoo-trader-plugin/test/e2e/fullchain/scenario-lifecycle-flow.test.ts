/**
 * Phase F — Scenario: Lifecycle Flow
 *
 * Tests the Flow dashboard endpoints, activity SSE stream, approve/reject flow,
 * and LifecycleEngine.runCycle() integration with real HTTP server.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-lifecycle-flow.test.ts
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

import { createFullChainServer, fetchJson, fetchText, type FullChainContext } from "./harness.js";

/**
 * Collect SSE `data:` payloads from an event-stream URL.
 * Resolves when `count` events are collected or `timeoutMs` expires.
 */
function collectSseEvents(url: string, count: number, timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const events: string[] = [];
    const parsed = new URL(url);
    const req = http.get(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search },
      (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const match = line.match(/^data: (.+)$/);
            if (match) {
              events.push(match[1]!);
              if (events.length >= count) {
                req.destroy();
                resolve(events);
                return;
              }
            }
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        reject(err);
      }
    });
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

describe("Phase F — Scenario: Lifecycle Flow", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. Flow dashboard HTML endpoint ──
  it("GET /dashboard/flow returns HTML with pipeline columns and activity timeline", async () => {
    const { status, body } = await fetchText(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/flow`);

    expect(status).toBe(200);
    const html = body;
    // Should contain pipeline column identifiers
    expect(html).toContain("L0 Incubate");
    expect(html).toContain("L1 Backtest");
    expect(html).toContain("L2 Paper");
    expect(html).toContain("L3 Live");
    // Should contain activity timeline section
    expect(html).toContain("Agent Activity");
    expect(html).toContain("timelineEntries");
    // Should contain status bar
    expect(html).toContain("engineStatus");
    expect(html).toContain("cycleCount");
  });

  // ── 2. Flow JSON API endpoint ──
  it("GET /api/v1/finance/dashboard/flow returns JSON with strategies and engine stats", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/flow`);

    expect(status).toBe(200);
    const data = body as {
      strategies: unknown[];
      totalEquity: number;
      pendingApprovals: unknown[];
      lifecycleEngine: {
        running: boolean;
        cycleCount: number;
        lastCycleAt: number;
        promotionCount: number;
        demotionCount: number;
        pendingApprovals: number;
      };
    };
    expect(Array.isArray(data.strategies)).toBe(true);
    expect(typeof data.totalEquity).toBe("number");
    expect(Array.isArray(data.pendingApprovals)).toBe(true);
    expect(data.lifecycleEngine).toBeDefined();
    expect(typeof data.lifecycleEngine.running).toBe("boolean");
    expect(typeof data.lifecycleEngine.cycleCount).toBe("number");
  });

  // ── 3. Activity SSE stream pushes new entries ──
  it("SSE agent-activity/stream pushes new_entry when activityLog.append() is called", async () => {
    const ssePromise = collectSseEvents(
      `${ctx.baseUrl}/api/v1/finance/agent-activity/stream`,
      2,
      4000,
    );

    // Give the SSE connection time to establish
    await new Promise((r) => setTimeout(r, 300));

    // Inject a test entry through the activity log
    ctx.services.activityLog.append({
      category: "decision",
      action: "test_sse_push",
      detail: "SSE push test from lifecycle flow scenario",
    });

    const events = await ssePromise;
    expect(events.length).toBeGreaterThanOrEqual(2);

    // First event is the initial snapshot
    const initial = JSON.parse(events[0]!) as Record<string, unknown>;
    expect(initial.type).toBe("initial");
    expect(initial).toHaveProperty("entries");

    // Second event should be the pushed new_entry
    const pushed = JSON.parse(events[1]!) as Record<string, unknown>;
    expect(pushed.type).toBe("new_entry");
    expect(pushed).toHaveProperty("entry");
    const entry = pushed.entry as Record<string, unknown>;
    expect(entry.action).toBe("test_sse_push");
  });

  // ── 4. Approve L3 promotion via HTTP ──
  it("POST /flow/approve promotes L2 strategy to L3 and returns ok", async () => {
    // Create a strategy and set it to L2_PAPER
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "Flow Approve Test",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createRes.status).toBe(201);
    const strategyId = (createRes.body as { strategy: { id: string } }).strategy.id;

    // Move to L2_PAPER via registry directly
    ctx.services.strategyRegistry.updateLevel(strategyId, "L2_PAPER" as never);

    // Approve via HTTP
    const approveRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/flow/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId }),
    });

    expect(approveRes.status).toBe(200);
    const approveData = approveRes.body as { ok: boolean; strategyId: string };
    expect(approveData.ok).toBe(true);
    expect(approveData.strategyId).toBe(strategyId);

    // Verify level changed in registry
    const updated = ctx.services.strategyRegistry.get(strategyId);
    expect(updated?.level).toBe("L3_LIVE");
  });

  // ── 5. Approve on non-L2 strategy returns 404 ──
  it("POST /flow/approve returns 404 for non-L2 strategy", async () => {
    // Create a strategy at L0 (default)
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "Not L2 Strategy",
        symbol: "ETH/USDT",
        timeframe: "4h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createRes.status).toBe(201);
    const strategyId = (createRes.body as { strategy: { id: string } }).strategy.id;

    const approveRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/flow/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId }),
    });

    expect(approveRes.status).toBe(404);
    const data = approveRes.body as { ok: boolean };
    expect(data.ok).toBe(false);
  });

  // ── 6. LifecycleEngine start/stop records heartbeat ──
  it("start/stop records heartbeat activity in real harness", async () => {
    const beforeCount = ctx.services.activityLog.listRecent(100).length;

    ctx.services.lifecycleEngine.start();
    expect(ctx.services.lifecycleEngine.getStats().running).toBe(true);
    ctx.services.lifecycleEngine.stop();

    const afterCount = ctx.services.activityLog.listRecent(100).length;
    expect(afterCount).toBeGreaterThan(beforeCount);

    const heartbeatLogs = ctx.services.activityLog.listRecent(10, "heartbeat");
    expect(heartbeatLogs.some((l) => l.action === "lifecycle_engine_started")).toBe(true);
  });

  // ── 7. runCycle() full chain: create L1 strategy → runCycle → verify recommendation (Agent-sovereign) ──
  it("runCycle() recommends L1→L2 promotion via wake bridge (does not auto-execute)", async () => {
    // Create a strategy with data that satisfies real FundManager L1→L2 gates
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "RunCycle Full Chain",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createRes.status).toBe(201);
    const strategyId = (createRes.body as { strategy: { id: string } }).strategy.id;

    // Set to L1 with data that passes real promotion gates:
    // sharpe ≥ 1.0, |maxDD| ≤ 25%, trades ≥ 100, walkForward.passed
    ctx.services.strategyRegistry.updateLevel(strategyId, "L1_BACKTEST" as never);
    ctx.services.strategyRegistry.updateBacktest(strategyId, {
      strategyId,
      startDate: Date.now() - 86_400_000 * 90,
      endDate: Date.now(),
      initialCapital: 10000,
      finalEquity: 13500,
      totalReturn: 35,
      sharpe: 1.5,
      sortino: 2.0,
      maxDrawdown: -12,
      calmar: 2.9,
      winRate: 0.58,
      profitFactor: 1.8,
      totalTrades: 150,
      trades: [],
      equityCurve: [],
      dailyReturns: [],
    } as never);
    ctx.services.strategyRegistry.updateWalkForward(strategyId, {
      passed: true,
      windows: [],
      combinedTestSharpe: 1.2,
      avgTrainSharpe: 1.5,
      ratio: 0.8,
      threshold: 0.6,
    } as never);

    // Execute lifecycle cycle — real FundManager gates will evaluate
    const result = await ctx.services.lifecycleEngine.runCycle();
    expect(result.promoted).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    // LifecycleEngine no longer auto-executes — strategy stays at L1
    const updated = ctx.services.strategyRegistry.get(strategyId);
    expect(updated?.level).toBe("L1_BACKTEST");

    // Activity log should have lifecycle recommendation (not direct promotion)
    const lifecycleLogs = ctx.services.activityLog.listRecent(100, "lifecycle");
    expect(lifecycleLogs.some((l) => l.action === "lifecycle_recommendation")).toBe(true);

    // Wake bridge pending wakes should include the recommendation
    const pending = ctx.services.wakeBridge.getPending();
    expect(pending.some((w) => w.contextKey === "cron:findoo:lifecycle-recommendation")).toBe(true);

    // Verify engine stats
    expect(ctx.services.lifecycleEngine.getStats().cycleCount).toBeGreaterThanOrEqual(1);
  });
});
