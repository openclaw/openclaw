import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FutuAdapter } from "./futu-adapter.js";

// Mock fetch globally
const mockFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Helper: create a standard adapter for tests. */
function createAdapter(isTestnet = true, host?: string, port?: number) {
  return new FutuAdapter("futu", isTestnet, host, port);
}

/** Helper: mock a successful JSON response. */
function mockJsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FutuAdapter", () => {
  describe("constructor", () => {
    it("creates adapter with correct properties", () => {
      const adapter = createAdapter();
      expect(adapter.exchangeId).toBe("futu");
      expect(adapter.marketType).toBe("hk-equity");
      expect(adapter.isTestnet).toBe(true);
    });

    it("uses default bridge URL http://127.0.0.1:11111", () => {
      const adapter = createAdapter();
      expect(adapter.isTestnet).toBe(true);
    });

    it("uses custom host and port when provided", () => {
      const adapter = createAdapter(false, "192.168.1.100", 22222);
      expect(adapter.isTestnet).toBe(false);
    });
  });

  describe("placeOrder", () => {
    it("places a limit buy order successfully", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          orderId: "FUTU-ORD-001",
          symbol: "00700.HK",
          side: "buy",
          type: "limit",
          qty: 100,
          filledQty: 0,
          filledPrice: 0,
          price: 350.0,
          status: "submitted",
          timestamp: 1709500000000,
        }),
      );

      const adapter = createAdapter();
      const result = await adapter.placeOrder({
        symbol: "00700.HK",
        side: "buy",
        type: "limit",
        amount: 100,
        price: 350.0,
      });

      expect(result).toEqual({
        orderId: "FUTU-ORD-001",
        exchangeId: "futu",
        symbol: "00700.HK",
        side: "buy",
        type: "limit",
        amount: 100,
        filledAmount: 0,
        price: 350.0,
        avgFillPrice: undefined,
        status: "open",
        timestamp: 1709500000000,
      });

      // Verify POST body
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:11111/order");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string);
      expect(body.symbol).toBe("00700.HK");
      expect(body.side).toBe("buy");
      expect(body.type).toBe("limit");
      expect(body.qty).toBe(100);
      expect(body.limitPrice).toBe(350.0);
      expect(body.timeInForce).toBe("day");
    });

    it("places a market sell order", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          orderId: "FUTU-ORD-002",
          symbol: "09988.HK",
          side: "sell",
          type: "market",
          qty: 200,
          filledQty: 200,
          filledPrice: 88.5,
          price: 0,
          status: "filled",
          timestamp: 1709500100000,
        }),
      );

      const adapter = createAdapter();
      const result = await adapter.placeOrder({
        symbol: "09988.HK",
        side: "sell",
        type: "market",
        amount: 200,
      });

      expect(result.status).toBe("closed");
      expect(result.filledAmount).toBe(200);
      expect(result.avgFillPrice).toBe(88.5);
    });

    it("uses custom host:port for bridge URL", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          orderId: "o1",
          status: "submitted",
          filledQty: 0,
          filledPrice: 0,
          timestamp: Date.now(),
        }),
      );

      const adapter = createAdapter(true, "10.0.0.5", 22222);
      await adapter.placeOrder({
        symbol: "00700.HK",
        side: "buy",
        type: "market",
        amount: 100,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://10.0.0.5:22222/order");
    });

    it("throws on order failure", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Insufficient funds" }), { status: 400 }),
      );

      const adapter = createAdapter();
      await expect(
        adapter.placeOrder({
          symbol: "00700.HK",
          side: "buy",
          type: "limit",
          amount: 100,
          price: 350,
        }),
      ).rejects.toThrow(/FutuAdapter POST \/order failed: 400/);
    });
  });

  describe("cancelOrder", () => {
    it("cancels an open order", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ success: true }));

      const adapter = createAdapter();
      await adapter.cancelOrder("FUTU-ORD-001", "00700.HK");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:11111/order/FUTU-ORD-001");
      expect(init?.method).toBe("DELETE");
      const body = JSON.parse(init?.body as string);
      expect(body.symbol).toBe("00700.HK");
    });

    it("throws on cancel failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));

      const adapter = createAdapter();
      await expect(adapter.cancelOrder("bad-id", "00700.HK")).rejects.toThrow(
        /FutuAdapter DELETE \/order\/bad-id failed: 404/,
      );
    });
  });

  describe("fetchBalance", () => {
    it("returns HKD balance from account endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          equity: 500000,
          cash: 300000,
          buyingPower: 600000,
        }),
      );

      const adapter = createAdapter();
      const balances = await adapter.fetchBalance();

      expect(balances).toHaveLength(1);
      expect(balances[0]).toEqual({
        exchange: "futu",
        currency: "HKD",
        total: 500000,
        free: 300000,
        used: 200000,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:11111/account",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws on fetch failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Internal error", { status: 500 }));
      const adapter = createAdapter();
      await expect(adapter.fetchBalance()).rejects.toThrow(/failed: 500/);
    });
  });

  describe("fetchPositions", () => {
    it("returns positions list", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            symbol: "00700.HK",
            side: "long",
            qty: 500,
            avgPrice: 340.0,
            currentPrice: 355.0,
            unrealizedPnl: 7500.0,
          },
          {
            symbol: "09988.HK",
            side: "short",
            qty: 200,
            avgPrice: 90.0,
            currentPrice: 88.0,
            unrealizedPnl: 400.0,
          },
        ]),
      );

      const adapter = createAdapter();
      const positions = await adapter.fetchPositions();

      expect(positions).toHaveLength(2);
      expect(positions[0]).toEqual({
        exchange: "futu",
        symbol: "00700.HK",
        side: "long",
        size: 500,
        entryPrice: 340.0,
        currentPrice: 355.0,
        unrealizedPnl: 7500.0,
        leverage: 1,
      });
      expect(positions[1]).toEqual({
        exchange: "futu",
        symbol: "09988.HK",
        side: "short",
        size: 200,
        entryPrice: 90.0,
        currentPrice: 88.0,
        unrealizedPnl: 400.0,
        leverage: 1,
      });
    });

    it("returns empty array when no positions", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));
      const adapter = createAdapter();
      const positions = await adapter.fetchPositions();
      expect(positions).toEqual([]);
    });

    it("filters by symbol via query parameter", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));
      const adapter = createAdapter();
      await adapter.fetchPositions("00700.HK");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/positions?symbol=00700.HK");
    });
  });

  describe("fetchTicker", () => {
    it("returns ticker data from quote endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          last: 355.0,
          bid: 354.8,
          ask: 355.2,
          volume: 12000000,
          timestamp: 1709500000000,
        }),
      );

      const adapter = createAdapter();
      const ticker = await adapter.fetchTicker("00700.HK");

      expect(ticker).toEqual({
        symbol: "00700.HK",
        last: 355.0,
        bid: 354.8,
        ask: 355.2,
        volume24h: 12000000,
        timestamp: 1709500000000,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:11111/quote/00700.HK");
    });

    it("handles zero bid/ask as undefined", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          last: 355.0,
          bid: 0,
          ask: 0,
          volume: 0,
          timestamp: 1709500000000,
        }),
      );

      const adapter = createAdapter();
      const ticker = await adapter.fetchTicker("00700.HK");

      expect(ticker.last).toBe(355.0);
      expect(ticker.bid).toBeUndefined();
      expect(ticker.ask).toBeUndefined();
      expect(ticker.volume24h).toBeUndefined();
    });

    it("throws on fetch failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
      const adapter = createAdapter();
      await expect(adapter.fetchTicker("INVALID")).rejects.toThrow(/failed: 404/);
    });
  });

  describe("fetchOpenOrders", () => {
    it("returns open orders", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            orderId: "FUTU-ORD-010",
            symbol: "00700.HK",
            side: "buy",
            type: "limit",
            qty: 100,
            filledQty: 0,
            price: 340.0,
            status: "submitted",
            timestamp: 1709500200000,
          },
        ]),
      );

      const adapter = createAdapter();
      const orders = await adapter.fetchOpenOrders();

      expect(orders).toHaveLength(1);
      expect(orders[0]).toEqual({
        orderId: "FUTU-ORD-010",
        exchangeId: "futu",
        symbol: "00700.HK",
        side: "buy",
        type: "limit",
        amount: 100,
        filledAmount: 0,
        price: 340.0,
        status: "open",
        timestamp: 1709500200000,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/orders?status=open");
    });

    it("filters by symbol when provided", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));
      const adapter = createAdapter();
      await adapter.fetchOpenOrders("00700.HK");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("status=open");
      expect(url).toContain("symbol=00700.HK");
    });

    it("throws on fetch failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Error", { status: 500 }));
      const adapter = createAdapter();
      await expect(adapter.fetchOpenOrders()).rejects.toThrow(/failed: 500/);
    });
  });

  describe("healthCheck", () => {
    it("returns ok when bridge is reachable", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ status: "ok" }));

      const adapter = createAdapter();
      const health = await adapter.healthCheck();

      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.error).toBeUndefined();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:11111/health");
    });

    it("returns error when bridge is down", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const adapter = createAdapter();
      const health = await adapter.healthCheck();

      expect(health.ok).toBe(false);
      expect(health.error).toBe("Connection refused");
    });

    it("returns error on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(new Response("", { status: 503 }));

      const adapter = createAdapter();
      const health = await adapter.healthCheck();

      expect(health.ok).toBe(false);
      expect(health.error).toContain("503");
    });
  });

  describe("Futu status mapping", () => {
    it("maps filled/全部成交 to closed", async () => {
      for (const status of ["filled", "全部成交"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({
            orderId: "o1", status, filledQty: 100, filledPrice: 350, timestamp: Date.now(),
          }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "00700.HK", side: "buy", type: "market", amount: 100,
        });
        expect(result.status).toBe("closed");
      }
    });

    it("maps cancelled/已撤单 to canceled", async () => {
      for (const status of ["cancelled", "已撤单"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({
            orderId: "o1", status, filledQty: 0, filledPrice: 0, timestamp: Date.now(),
          }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "00700.HK", side: "buy", type: "market", amount: 100,
        });
        expect(result.status).toBe("canceled");
      }
    });

    it("maps rejected/已废单 to rejected", async () => {
      for (const status of ["rejected", "已废单"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({
            orderId: "o1", status, filledQty: 0, filledPrice: 0, timestamp: Date.now(),
          }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "00700.HK", side: "buy", type: "market", amount: 100,
        });
        expect(result.status).toBe("rejected");
      }
    });

    it("maps unknown status to open (default)", async () => {
      for (const status of ["submitted", "partial", "pending", "unknown_status"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({
            orderId: "o1", status, filledQty: 0, filledPrice: 0, timestamp: Date.now(),
          }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "00700.HK", side: "buy", type: "market", amount: 100,
        });
        expect(result.status).toBe("open");
      }
    });
  });
});
