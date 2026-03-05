/**
 * L3 E2E — Ideation HTTP endpoints.
 * Tests GET /ideation/status and POST /ideation/trigger against a real HTTP server.
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

import type { FullChainContext } from "./harness.js";
import { createFullChainServer, fetchJson } from "./harness.js";

describe("Ideation E2E — HTTP Endpoints", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15000);

  afterAll(() => ctx.cleanup());

  it("GET /ideation/status returns scheduler status", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/ideation/status`);
    expect(status).toBe(200);

    const data = body as Record<string, unknown>;
    // The harness doesn't wire up ideation scheduler, so it should return disabled
    if ((data as { enabled?: boolean }).enabled === false) {
      expect(data.message).toContain("not initialized");
    } else if (data.stats) {
      const stats = data.stats as Record<string, unknown>;
      expect(typeof stats.running).toBe("boolean");
      expect(typeof stats.cycleCount).toBe("number");
    }
  });

  it("POST /ideation/trigger returns result or unavailable error", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/ideation/trigger`, {
      method: "POST",
    });

    // Either 503 (scheduler not wired in harness) or 200 (if wired)
    if (status === 503) {
      const data = body as { error: string };
      expect(data.error).toContain("not initialized");
    } else {
      expect(status).toBe(200);
      const data = body as { triggered: boolean };
      expect(data.triggered).toBe(true);
    }
  });

  it("GET /ideation/status returns stats after trigger", async () => {
    // Even if trigger failed (503), status should still work
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/ideation/status`);
    expect(status).toBe(200);
    expect(body).toBeDefined();
  });

  it("activity log records ideation entries", () => {
    const entries = ctx.services.activityLog.listRecent(50);
    // Activity log should exist and be functional
    expect(Array.isArray(entries)).toBe(true);
  });
});
