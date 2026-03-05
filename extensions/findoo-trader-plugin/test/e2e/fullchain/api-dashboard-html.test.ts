/**
 * Phase F — B11: Dashboard HTML routes full-chain E2E tests.
 * Tests GET /plugins/findoo-trader/dashboard/{overview,strategy,trader,setting} return rendered HTML (or JSON fallback),
 * legacy /dashboard/* paths redirect 301 to namespaced paths,
 * and alias redirects (302) for finance, trading, command-center, mission-control,
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

const P = "/plugins/findoo-trader/dashboard";

describe("Phase F — Dashboard HTML Routes (B11)", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15000);

  afterAll(() => ctx.cleanup());

  // ── Primary dashboard pages at namespaced paths (200 with HTML or JSON fallback) ──

  it("1. GET /plugins/findoo-trader/dashboard/overview returns 200 with content", async () => {
    const { status, body, headers } = await fetchText(`${ctx.baseUrl}${P}/overview`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    const ct = headers.get("content-type") ?? "";
    expect(ct.includes("text/html") || ct.includes("application/json")).toBe(true);
  });

  it("2. GET /plugins/findoo-trader/dashboard/strategy returns 200 with content", async () => {
    const { status, body, headers } = await fetchText(`${ctx.baseUrl}${P}/strategy`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    const ct = headers.get("content-type") ?? "";
    expect(ct.includes("text/html") || ct.includes("application/json")).toBe(true);
  });

  it("3. GET /plugins/findoo-trader/dashboard/trader returns 200 with content", async () => {
    const { status, body, headers } = await fetchText(`${ctx.baseUrl}${P}/trader`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    const ct = headers.get("content-type") ?? "";
    expect(ct.includes("text/html") || ct.includes("application/json")).toBe(true);
  });

  it("4. GET /plugins/findoo-trader/dashboard/setting returns 200 with content", async () => {
    const { status, body, headers } = await fetchText(`${ctx.baseUrl}${P}/setting`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    const ct = headers.get("content-type") ?? "";
    expect(ct.includes("text/html") || ct.includes("application/json")).toBe(true);
  });

  // ── Backward-compat: /dashboard/* → 301 → /plugins/findoo-trader/dashboard/* ──

  it("5. /dashboard/overview redirects 301 to namespaced path", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}/dashboard/overview`);
    expect(status).toBe(301);
    expect(headers.get("location")).toBe(`${P}/overview`);
  });

  it("6. /dashboard/strategy redirects 301 to namespaced path", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}/dashboard/strategy`);
    expect(status).toBe(301);
    expect(headers.get("location")).toBe(`${P}/strategy`);
  });

  // ── Alias redirects at namespaced paths (302) ──

  it("7. namespaced /finance redirects 302 to overview", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}${P}/finance`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe(`${P}/overview`);
  });

  it("8. namespaced /trading redirects 302 to trader", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}${P}/trading`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe(`${P}/trader`);
  });

  it("9. namespaced /command-center redirects 302 to trader", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}${P}/command-center`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe(`${P}/trader`);
  });

  it("10. namespaced /mission-control redirects 302 to overview", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}${P}/mission-control`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe(`${P}/overview`);
  });

  it("11. namespaced /strategy-arena redirects 302 to strategy", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}${P}/strategy-arena`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe(`${P}/strategy`);
  });

  it("12. namespaced /strategy-lab redirects 302 to strategy", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}${P}/strategy-lab`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe(`${P}/strategy`);
  });

  it("13. namespaced /trading-desk redirects 302 to trader", async () => {
    const { status, headers } = await fetchText(`${ctx.baseUrl}${P}/trading-desk`);
    expect(status).toBe(302);
    expect(headers.get("location")).toBe(`${P}/trader`);
  });
});
