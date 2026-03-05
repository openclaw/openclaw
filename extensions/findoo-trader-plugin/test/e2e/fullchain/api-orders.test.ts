/**
 * Phase F — B3: Orders + Positions full-chain E2E tests.
 *
 * Exercises the complete order lifecycle through a real HTTP server with all
 * 16+ service instances wired up: risk evaluation tiers (auto / confirm / reject),
 * paper engine order execution, cancel flow, position close, and the approval
 * bypass path.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/api-orders.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFullChainServer,
  fetchJson,
  DEFAULT_RISK_CONFIG,
  type FullChainContext,
} from "./harness.js";

// ── Mock ccxt (no real exchange connections) ──

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

// ── Test suite ──

describe("Phase F — B3: Orders + Positions", () => {
  let ctx: FullChainContext;
  let accountId: string;

  beforeAll(async () => {
    ctx = await createFullChainServer();

    // Create a paper account so order submission has a target.
    const acct = ctx.services.paperEngine.createAccount("test-account", 10_000);
    accountId = acct.id;
  });

  afterAll(() => {
    ctx.cleanup();
  });

  // ── 1. Small order (auto tier) → 201 ──

  it("POST /orders — small paper order auto-approved → 201", async () => {
    // estimatedUsd = 10 * 1 = $10 ≤ maxAutoTradeUsd (100) → auto
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        quantity: 1,
        currentPrice: 10,
        reason: "e2e test small order",
        accountId,
      }),
    });

    expect(status).toBe(201);
    const order = body as Record<string, unknown>;
    expect(order.symbol).toBe("BTC/USDT");
    expect(order.side).toBe("buy");
    expect(order.status).toBe("filled");
    expect(order.accountId).toBe(accountId);
  });

  // ── 2. Medium order (confirm tier) → 202 pending_approval ──

  it("POST /orders — medium amount → 202 pending_approval with eventId", async () => {
    // estimatedUsd = 200 * 3 = $600 → > maxAutoTradeUsd (100), ≤ confirmThresholdUsd (1000) → confirm
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "ETH/USDT",
        side: "buy",
        type: "market",
        quantity: 3,
        currentPrice: 200,
        accountId,
      }),
    });

    expect(status).toBe(202);
    const result = body as Record<string, unknown>;
    expect(result.status).toBe("pending_approval");
    expect(result.eventId).toBeDefined();
    expect(typeof result.eventId).toBe("string");
    expect(result.reason).toContain("auto-trade limit");
  });

  // ── 3. Very large order (reject tier) → 403 ──

  it("POST /orders — very large amount → 403 reject", async () => {
    // estimatedUsd = 1000 * 10 = $10,000 > confirmThresholdUsd (1000) → reject
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        quantity: 10,
        currentPrice: 1000,
        accountId,
      }),
    });

    expect(status).toBe(403);
    const result = body as Record<string, unknown>;
    expect(result.error).toContain("confirmation threshold");
  });

  // ── 4. Missing required field → 400 ──

  it("POST /orders — missing symbol → 400", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        side: "buy",
        quantity: 1,
        currentPrice: 10,
        accountId,
      }),
    });

    expect(status).toBe(400);
    const result = body as Record<string, unknown>;
    expect(result.error).toContain("Missing required fields");
  });

  // ── 5. Cancel order → 200 ──

  it("POST /orders/cancel — cancel existing order → 200", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: "order-fake-123",
        accountId,
      }),
    });

    expect(status).toBe(200);
    const result = body as Record<string, unknown>;
    expect(result.status).toBe("cancelled");
    expect(result.orderId).toBe("order-fake-123");
  });

  // ── 6. Cancel missing orderId → 400 ──

  it("POST /orders/cancel — missing orderId → 400", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });

    expect(status).toBe(400);
    const result = body as Record<string, unknown>;
    expect(result.error).toContain("orderId");
  });

  // ── 7. Close position with existing position → 200 ──

  it("POST /positions/close — close existing position → 200", async () => {
    // First, place a small buy order to create a position for SOL/USDT.
    const buyRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "SOL/USDT",
        side: "buy",
        type: "market",
        quantity: 5,
        currentPrice: 10,
        reason: "create position for close test",
        accountId,
      }),
    });
    expect(buyRes.status).toBe(201);

    // Now close the position.
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/positions/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "SOL/USDT",
        accountId,
      }),
    });

    expect(status).toBe(200);
    const result = body as Record<string, unknown>;
    expect(result.status).toBe("closed");
    expect(result.order).toBeDefined();
    const closeOrder = result.order as Record<string, unknown>;
    expect(closeOrder.symbol).toBe("SOL/USDT");
    expect(closeOrder.side).toBe("sell");
  });

  // ── 8. Close position missing symbol → 400 ──

  it("POST /positions/close — missing symbol → 400", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/positions/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });

    expect(status).toBe(400);
    const result = body as Record<string, unknown>;
    expect(result.error).toContain("symbol");
  });

  // ── 9. Close position non-existent symbol → 404 ──

  it("POST /positions/close — non-existent symbol → 404", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/positions/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "DOGE/USDT",
        accountId,
      }),
    });

    expect(status).toBe(404);
    const result = body as Record<string, unknown>;
    expect(result.error).toContain("DOGE/USDT");
  });

  // ── 10. Approved order bypasses risk → 201 ──

  it("POST /orders — approved order bypasses risk evaluation → 201", async () => {
    // Step 1: Submit a medium order that triggers the confirm tier.
    // estimatedUsd = 200 * 3 = $600 → confirm tier → 202 with eventId
    const pendingRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "AVAX/USDT",
        side: "buy",
        type: "market",
        quantity: 3,
        currentPrice: 200,
        accountId,
      }),
    });

    expect(pendingRes.status).toBe(202);
    const pendingBody = pendingRes.body as Record<string, unknown>;
    const eventId = pendingBody.eventId as string;
    expect(eventId).toBeDefined();

    // Step 2: Approve the event via the approval endpoint.
    const approvalRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: eventId, action: "approve" }),
    });

    expect(approvalRes.status).toBe(200);
    const approvalBody = approvalRes.body as Record<string, unknown>;
    expect(approvalBody.status).toBe("approved");

    // Step 3: Re-submit the same order with the approvalId — should bypass risk and execute.
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "AVAX/USDT",
        side: "buy",
        type: "market",
        quantity: 3,
        currentPrice: 200,
        approvalId: eventId,
        accountId,
      }),
    });

    expect(status).toBe(201);
    const order = body as Record<string, unknown>;
    expect(order.symbol).toBe("AVAX/USDT");
    expect(order.side).toBe("buy");
    expect(order.status).toBe("filled");
    expect(order.accountId).toBe(accountId);
  });
});
