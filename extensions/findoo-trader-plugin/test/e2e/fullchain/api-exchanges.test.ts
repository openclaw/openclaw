/**
 * Phase F — B10: Exchange Management API full-chain E2E tests.
 * Tests POST /exchanges, POST /exchanges/test, POST /exchanges/remove
 * against real ExchangeRegistry + ExchangeHealthStore with mocked ccxt.
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
      bids: [
        [65000, 1.5],
        [64900, 2.0],
      ],
      asks: [
        [65100, 1.2],
        [65200, 0.8],
      ],
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

describe("Phase F — Exchange Management API (B10)", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15000);

  afterAll(() => ctx.cleanup());

  // 1. POST /exchanges adds exchange -> 201
  it("POST /exchanges adds a new exchange and returns 201", async () => {
    const payload = {
      exchange: "binance",
      apiKey: "test-api-key-123",
      secret: "test-secret-456",
      testnet: true,
      label: "my-binance-testnet",
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/exchanges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(201);
    const data = body as { id: string; exchange: string; testnet: boolean };
    expect(data.id).toBe("my-binance-testnet");
    expect(data.exchange).toBe("binance");
    expect(data.testnet).toBe(true);
  });

  // 2. POST /exchanges validates schema (missing exchange type -> 400)
  it("POST /exchanges returns 400 when exchange type is missing", async () => {
    const payload = {
      apiKey: "some-key",
      secret: "some-secret",
      // exchange is missing
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/exchanges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(400);
    const data = body as { error: string };
    expect(data.error).toBeDefined();
  });

  // 3. POST /exchanges/test tests connection -> returns success (uses mock ccxt)
  it("POST /exchanges/test returns success for configured exchange", async () => {
    // Ensure the exchange exists (created in test 1)
    const listBefore = ctx.services.registry.listExchanges();
    const exists = listBefore.some((e) => e.id === "my-binance-testnet");
    if (!exists) {
      // Re-add if tests run in isolation
      ctx.services.registry.addExchange("my-binance-testnet", {
        exchange: "binance",
        apiKey: "test-api-key-123",
        secret: "test-secret-456",
        testnet: true,
      });
    }

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/exchanges/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "my-binance-testnet" }),
    });

    expect(status).toBe(200);
    const data = body as {
      success: boolean;
      latencyMs: number;
      balance?: unknown[];
      markets?: string[];
    };
    expect(data.success).toBe(true);
    expect(typeof data.latencyMs).toBe("number");
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // 4. POST /exchanges/remove removes exchange -> 200
  it("POST /exchanges/remove removes an existing exchange", async () => {
    // Ensure the exchange exists
    const listBefore = ctx.services.registry.listExchanges();
    const exists = listBefore.some((e) => e.id === "my-binance-testnet");
    if (!exists) {
      ctx.services.registry.addExchange("my-binance-testnet", {
        exchange: "binance",
        apiKey: "test-api-key-123",
        secret: "test-secret-456",
        testnet: true,
      });
    }

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/exchanges/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "my-binance-testnet" }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; id: string };
    expect(data.status).toBe("removed");
    expect(data.id).toBe("my-binance-testnet");

    // Verify it is gone from the registry
    const listAfter = ctx.services.registry.listExchanges();
    expect(listAfter.find((e) => e.id === "my-binance-testnet")).toBeUndefined();
  });

  // 5. POST /exchanges/remove invalid id -> 404
  it("POST /exchanges/remove returns 404 for non-existent exchange", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/exchanges/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "does-not-exist-exchange" }),
    });

    expect(status).toBe(404);
    const data = body as { error: string };
    expect(data.error).toMatch(/not found/i);
  });
});
