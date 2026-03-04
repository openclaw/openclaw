/**
 * Phase D — Gateway E2E test (Layer 2)
 *
 * Boots a real HTTP server with the plugin's route handlers wired to real
 * service instances (AlertEngine, JsonConfigStore). Tests the full
 * network roundtrip: HTTP client → server → route handler → real service → response.
 *
 * This is a lighter-weight alternative to the full OpenClaw gateway harness
 * but exercises the same critical path: real HTTP I/O + real services.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/phase-d-gateway.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AlertEngine } from "../../src/core/alert-engine.js";
import { JsonConfigStore } from "../../src/core/config-store.js";
import type { RuntimeServices, HttpReq, HttpRes } from "../../src/types-http.js";

// Mock ccxt
vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return { binance: MockExchange, okx: MockExchange };
});

// ── HTTP helpers ──

async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind port");
  const port = addr.port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function fetchJson(
  url: string,
  opts?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, opts);
  const body = await res.json();
  return { status: res.status, body };
}

// ── Test suite ──

describe("Phase D — Gateway E2E (real HTTP)", () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;
  let alertEngine: AlertEngine;

  beforeAll(async () => {
    dir = join(tmpdir(), `phase-d-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });

    // Create real services
    alertEngine = new AlertEngine(join(dir, "alerts.sqlite"));
    const agentConfigStore = new JsonConfigStore(join(dir, "agent-config.json"), {
      heartbeatIntervalMs: 60000,
      discoveryEnabled: true,
      evolutionEnabled: false,
      mutationRate: 0.1,
      maxConcurrentStrategies: 5,
    });
    const gateConfigStore = new JsonConfigStore(join(dir, "gate-config.json"), {
      l0l1: { minDays: 7, minSharpe: 0.5, maxDrawdown: -0.2, minWinRate: 0.4, minTrades: 10 },
      l1l2: { minDays: 14, minSharpe: 1.0, maxDrawdown: -0.15, minWinRate: 0.45, minTrades: 30 },
      l2l3: { minDays: 30, minSharpe: 1.5, maxDrawdown: -0.1, minWinRate: 0.5, minTrades: 50 },
    });

    const runtime: RuntimeServices = {
      services: new Map<string, unknown>([
        ["fin-alert-engine", alertEngine],
        ["fin-agent-config", agentConfigStore],
        ["fin-gate-config", gateConfigStore],
      ]),
    };

    // Capture routes from alert + setting modules
    const routes = new Map<string, (req: HttpReq, res: HttpRes) => Promise<void>>();
    const fakeApi = {
      registerHttpRoute({
        path,
        handler,
      }: {
        path: string;
        handler: (req: HttpReq, res: HttpRes) => Promise<void>;
      }) {
        routes.set(path, handler);
      },
    };

    const mockEventStore = {
      addEvent: vi.fn((input: Record<string, unknown>) => ({
        ...input,
        id: `evt-${Date.now()}`,
        timestamp: Date.now(),
      })),
      listEvents: vi.fn(() => []),
      pendingCount: vi.fn(() => 0),
      getEvent: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
    };

    // Register alert routes
    const { registerAlertRoutes } = await import("../../src/core/routes-alerts.js");
    registerAlertRoutes(fakeApi as never, runtime, mockEventStore as never);

    // Register setting routes (for config/agent and config/gates)
    const { ExchangeRegistry } = await import("../../src/core/exchange-registry.js");
    const { RiskController } = await import("../../src/core/risk-controller.js");
    const { registerSettingRoutes } = await import("../../src/core/routes-setting.js");
    registerSettingRoutes({
      api: fakeApi as never,
      registry: new ExchangeRegistry(),
      healthStore: { upsert: vi.fn(), listAll: vi.fn(() => []), get: vi.fn() } as never,
      riskController: new RiskController({
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 1000,
        maxDailyLossUsd: 5000,
        maxPositionPct: 20,
        maxLeverage: 10,
      }),
      eventStore: mockEventStore as never,
      runtime,
    });

    // Boot real HTTP server
    const port = await getFreePort();
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const handler = routes.get(url.pathname);
      if (handler) {
        handler(req as unknown as HttpReq, res as unknown as HttpRes).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        });
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    alertEngine.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════
  // Alert CRUD over real HTTP
  // ════════════════════════════════════════════════════════════

  it("GET /alerts → empty initially", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/alerts`);
    expect(status).toBe(200);
    expect((body as { alerts: unknown[] }).alerts).toEqual([]);
  });

  it("POST /alerts/create → 201 with id", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "price_above",
        symbol: "BTC/USDT",
        price: 75000,
        message: "BTC breakout!",
      }),
    });
    expect(status).toBe(201);
    expect((body as { id: string }).id).toBeTruthy();
  });

  it("GET /alerts → contains the created alert", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/alerts`);
    expect(status).toBe(200);
    const alerts = (
      body as { alerts: Array<{ condition: Record<string, unknown>; message?: string }> }
    ).alerts;
    expect(alerts.length).toBeGreaterThanOrEqual(1);

    const btcAlert = alerts.find((a) => a.condition.symbol === "BTC/USDT");
    expect(btcAlert).toBeDefined();
    expect(btcAlert!.condition.kind).toBe("price_above");
    expect(btcAlert!.condition.price).toBe(75000);
    expect(btcAlert!.message).toBe("BTC breakout!");
  });

  it("POST /alerts/create → POST /alerts/remove → alert gone", async () => {
    // Create
    const createResult = await fetchJson(`${baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "volume_spike", symbol: "ETH/USDT" }),
    });
    const alertId = (createResult.body as { id: string }).id;
    expect(alertId).toBeTruthy();

    // Remove
    const removeResult = await fetchJson(`${baseUrl}/api/v1/finance/alerts/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: alertId }),
    });
    expect(removeResult.status).toBe(200);

    // Verify it's gone (only the BTC one from previous test remains)
    const listResult = await fetchJson(`${baseUrl}/api/v1/finance/alerts`);
    const alerts = (listResult.body as { alerts: Array<{ id: string }> }).alerts;
    expect(alerts.find((a) => a.id === alertId)).toBeUndefined();
  });

  it("POST /alerts/remove with bogus id → 404", async () => {
    const { status } = await fetchJson(`${baseUrl}/api/v1/finance/alerts/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "nonexistent-id" }),
    });
    expect(status).toBe(404);
  });

  it("POST /alerts/create without kind → 400", async () => {
    const { status } = await fetchJson(`${baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "SOL/USDT" }),
    });
    expect(status).toBe(400);
  });

  // ════════════════════════════════════════════════════════════
  // Config CRUD over real HTTP
  // ════════════════════════════════════════════════════════════

  it("PUT /config/agent → 200 with updated config", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/config/agent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        heartbeatIntervalMs: 30000,
        discoveryEnabled: false,
        evolutionEnabled: true,
        mutationRate: 0.5,
        maxConcurrentStrategies: 20,
      }),
    });
    expect(status).toBe(200);
    const result = body as { status: string; config: Record<string, unknown> };
    expect(result.status).toBe("updated");
    expect(result.config.heartbeatIntervalMs).toBe(30000);
    expect(result.config.evolutionEnabled).toBe(true);
  });

  it("PUT /config/gates → 200 with updated gates", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/config/gates`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        l0l1: { minDays: 3, minSharpe: 0.3, maxDrawdown: -0.3, minWinRate: 0.3, minTrades: 5 },
        l1l2: { minDays: 7, minSharpe: 0.8, maxDrawdown: -0.2, minWinRate: 0.4, minTrades: 15 },
        l2l3: { minDays: 14, minSharpe: 1.2, maxDrawdown: -0.15, minWinRate: 0.45, minTrades: 35 },
      }),
    });
    expect(status).toBe(200);
    const result = body as { status: string; gates: Record<string, unknown> };
    expect(result.status).toBe("updated");
  });

  // ════════════════════════════════════════════════════════════
  // Stress: rapid create/remove cycle
  // ════════════════════════════════════════════════════════════

  it("handles 20 rapid create+remove cycles without data loss", async () => {
    const ids: string[] = [];

    // Create 20 alerts in parallel
    const createPromises = Array.from({ length: 20 }, (_, i) =>
      fetchJson(`${baseUrl}/api/v1/finance/alerts/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: `stress_test_${i}`, symbol: `STRESS${i}/USDT` }),
      }),
    );
    const createResults = await Promise.all(createPromises);
    for (const r of createResults) {
      expect(r.status).toBe(201);
      ids.push((r.body as { id: string }).id);
    }

    // Verify all 20 exist (plus any from previous tests)
    const listResult = await fetchJson(`${baseUrl}/api/v1/finance/alerts`);
    const allAlerts = (listResult.body as { alerts: Array<{ id: string }> }).alerts;
    for (const id of ids) {
      expect(allAlerts.find((a) => a.id === id)).toBeDefined();
    }

    // Remove all 20 in parallel
    const removePromises = ids.map((id) =>
      fetchJson(`${baseUrl}/api/v1/finance/alerts/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }),
    );
    const removeResults = await Promise.all(removePromises);
    for (const r of removeResults) {
      expect(r.status).toBe(200);
    }

    // Verify all 20 are gone
    const finalResult = await fetchJson(`${baseUrl}/api/v1/finance/alerts`);
    const remaining = (finalResult.body as { alerts: Array<{ id: string }> }).alerts;
    for (const id of ids) {
      expect(remaining.find((a) => a.id === id)).toBeUndefined();
    }
  });
});
