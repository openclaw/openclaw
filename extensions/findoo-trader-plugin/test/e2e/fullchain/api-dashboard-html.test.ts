/**
 * Phase F — B11: Dashboard HTML routes full-chain E2E tests.
 * Tests GET /dashboard/{overview,strategy,trader,setting} return rendered HTML (or JSON fallback),
 * and legacy alias redirects (302) for finance, trading, command-center, mission-control,
 * strategy-arena, strategy-lab, trading-desk, and fund routes.
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
import { createFullChainServer, fetchText } from "./harness.js";

describe("Phase F — Dashboard HTML Routes (B11)", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15000);

  afterAll(() => ctx.cleanup());

  // ── Primary dashboard pages (200 with HTML or JSON fallback) ──

  it("1. GET /dashboard/overview returns 200 with content", async () => {
    const { status, body, headers } = await fetchText(`${ctx.baseUrl}/dashboard/overview`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    const ct = headers.get("content-type") ?? "";
    // Should be HTML if templates loaded, or JSON fallback
    expect(ct.includes("text/html") || ct.includes("application/json")).toBe(true);
  });

  it("2. GET /dashboard/strategy returns 200 with content", async () => {
    const { status, body, headers } = await fetchText(`${ctx.baseUrl}/dashboard/strategy`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    const ct = headers.get("content-type") ?? "";
    expect(ct.includes("text/html") || ct.includes("application/json")).toBe(true);
  });

  it("3. GET /dashboard/trader returns 200 with content", async () => {
    const { status, body, headers } = await fetchText(`${ctx.baseUrl}/dashboard/trader`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    const ct = headers.get("content-type") ?? "";
    expect(ct.includes("text/html") || ct.includes("application/json")).toBe(true);
  });

  it("4. GET /dashboard/setting returns 200 with content", async () => {
    const { status, body, headers } = await fetchText(`${ctx.baseUrl}/dashboard/setting`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    const ct = headers.get("content-type") ?? "";
    expect(ct.includes("text/html") || ct.includes("application/json")).toBe(true);
  });

  // ── Redirect aliases (302 with Location header) ──

  it("5. /dashboard/finance redirects 302 to /dashboard/overview", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}/dashboard/finance`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe("/dashboard/overview");
  });

  it("6. /dashboard/trading redirects 302 to /dashboard/trader", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}/dashboard/trading`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe("/dashboard/trader");
  });

  it("7. /dashboard/command-center redirects 302 to /dashboard/trader", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}/dashboard/command-center`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe("/dashboard/trader");
  });

  it("8. /dashboard/mission-control redirects 302 to /dashboard/overview", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}/dashboard/mission-control`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe("/dashboard/overview");
  });

  it("9. /dashboard/strategy-arena redirects 302 to /dashboard/strategy", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}/dashboard/strategy-arena`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe("/dashboard/strategy");
  });

  it("10. /dashboard/strategy-lab redirects 302 to /dashboard/strategy", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}/dashboard/strategy-lab`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe("/dashboard/strategy");
  });

  it("11. /dashboard/trading-desk redirects 302 to /dashboard/trader", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}/dashboard/trading-desk`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe("/dashboard/trader");
  });

  it("12. /dashboard/fund returns 200 with HTML or JSON content", async () => {
    const { status, body, headers } = await fetchText(`${ctx.baseUrl}/dashboard/fund`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    const ct = headers.get("content-type") ?? "";
    // Fund dashboard serves HTML when template exists, JSON fallback otherwise
    expect(ct.includes("text/html") || ct.includes("application/json")).toBe(true);
  });
});
