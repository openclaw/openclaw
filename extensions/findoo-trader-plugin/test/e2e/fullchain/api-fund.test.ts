/**
 * Phase F — B6: Fund API full-chain E2E tests.
 * Validates all /api/v1/fund/* REST endpoints against a real server stack.
 */

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

import { createFullChainServer, fetchJson, type FullChainContext } from "./harness.js";

describe("B6 — Fund API full-chain", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  it("GET /fund/status returns fund overview with totalEquity = 100000", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/status`);
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data.totalEquity).toBe(100000);
    expect(data).toHaveProperty("todayPnl");
    expect(data).toHaveProperty("todayPnlPct");
    expect(data).toHaveProperty("riskLevel");
    expect(data).toHaveProperty("dailyDrawdown");
    expect(data).toHaveProperty("byLevel");
    expect(data).toHaveProperty("allocationCount");
    expect(data).toHaveProperty("lastRebalanceAt");
  });

  it("GET /fund/leaderboard returns empty leaderboard (no strategies yet)", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/leaderboard`);
    expect(status).toBe(200);
    const data = body as { leaderboard: unknown[]; total: number };
    expect(data.leaderboard).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("GET /fund/risk returns risk assessment with riskLevel and actions array", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/risk`);
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data).toHaveProperty("riskLevel");
    expect(data).toHaveProperty("scaleFactor");
    expect(Array.isArray(data.actions)).toBe(true);
    expect((data.actions as string[]).length).toBeGreaterThan(0);
  });

  it("GET /fund/allocations returns allocations with totalCapital = 100000", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/allocations`);
    expect(status).toBe(200);
    const data = body as {
      allocations: unknown[];
      totalAllocated: number;
      cashReserve: number;
      totalCapital: number;
    };
    expect(data.totalCapital).toBe(100000);
    expect(data.allocations).toEqual([]);
    expect(data.totalAllocated).toBe(0);
    expect(data.cashReserve).toBe(100000);
  });

  it("GET /fund/performance returns empty snapshots", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/performance`);
    expect(status).toBe(200);
    const data = body as { snapshots: unknown[]; total: number };
    expect(data.snapshots).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("GET /fund/capital-flows returns empty flows", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/capital-flows`);
    expect(status).toBe(200);
    const data = body as { flows: unknown[]; total: number };
    expect(data.flows).toEqual([]);
    expect(data.total).toBe(0);
  });
});
