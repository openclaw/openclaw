import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCtpAdapter } from "./openctp-adapter.js";

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
function createAdapter(isTestnet = true) {
  return new OpenCtpAdapter(
    "openctp-sim",
    isTestnet,
    "tcp://180.168.146.187:10130",
    "9999",
    "simnow_client_test",
    "0000000000000000",
    "http://127.0.0.1:7090",
  );
}

/** Helper: mock a successful JSON response. */
function mockJsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenCtpAdapter", () => {
  describe("constructor", () => {
    it("creates adapter with correct properties", () => {
      const adapter = createAdapter();
      expect(adapter.exchangeId).toBe("openctp-sim");
      expect(adapter.marketType).toBe("cn-a-share");
      expect(adapter.isTestnet).toBe(true);
    });

    it("defaults to testnet SimNow bridge", () => {
      const adapter = new OpenCtpAdapter(
        "ctp-test",
        true,
        "tcp://180.168.146.187:10130",
        "9999",
      );
      expect(adapter.isTestnet).toBe(true);
    });
  });

  describe("fetchBalance", () => {
    it("returns CNY balance from bridge", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          balance: 100000,
          available: 80000,
          frozenMargin: 15000,
          frozenCommission: 5000,
        }),
      );

      const adapter = createAdapter();
      const balances = await adapter.fetchBalance();

      expect(balances).toHaveLength(1);
      expect(balances[0]).toEqual({
        exchange: "openctp-sim",
        currency: "CNY",
        total: 100000,
        free: 80000,
        used: 20000,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:7090/account",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws on fetch failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Internal error", { status: 500 }));
      const adapter = createAdapter();
      await expect(adapter.fetchBalance()).rejects.toThrow(/failed: 500/);
    });
  });

  describe("placeOrder", () => {
    it("places a buy order successfully", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          orderId: "CTP-ORD-001",
          status: "submitted",
          filledQty: 0,
          filledPrice: 0,
          timestamp: 1709500000000,
        }),
      );

      const adapter = createAdapter();
      const result = await adapter.placeOrder({
        symbol: "600519.SS",
        side: "buy",
        type: "limit",
        amount: 100,
        price: 1800.5,
      });

      expect(result).toEqual({
        orderId: "CTP-ORD-001",
        exchangeId: "openctp-sim",
        symbol: "600519.SS",
        side: "buy",
        type: "limit",
        amount: 100,
        filledAmount: 0,
        price: 1800.5,
        avgFillPrice: undefined,
        status: "open",
        timestamp: 1709500000000,
      });

      // Verify POST body
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:7090/order");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string);
      expect(body.symbol).toBe("600519.SS");
      expect(body.side).toBe("buy");
      expect(body.qty).toBe(100);
      expect(body.limitPrice).toBe(1800.5);
    });

    it("places a market sell order", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          orderId: "CTP-ORD-002",
          status: "filled",
          filledQty: 100,
          filledPrice: 1795.0,
          timestamp: 1709500100000,
        }),
      );

      const adapter = createAdapter();
      const result = await adapter.placeOrder({
        symbol: "600519.SS",
        side: "sell",
        type: "market",
        amount: 100,
      });

      expect(result.status).toBe("closed");
      expect(result.filledAmount).toBe(100);
      expect(result.avgFillPrice).toBe(1795.0);
    });

    it("throws on order rejection", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Insufficient margin" }), { status: 400 }),
      );

      const adapter = createAdapter();
      await expect(
        adapter.placeOrder({
          symbol: "600519.SS",
          side: "buy",
          type: "limit",
          amount: 100,
          price: 1800,
        }),
      ).rejects.toThrow(/failed: 400/);
    });
  });

  describe("cancelOrder", () => {
    it("cancels an open order", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ success: true }));

      const adapter = createAdapter();
      await adapter.cancelOrder("CTP-ORD-001", "600519.SS");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:7090/order/CTP-ORD-001");
      expect(init?.method).toBe("DELETE");
    });
  });

  describe("fetchPositions", () => {
    it("returns positions list", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            symbol: "600519.SS",
            side: "long",
            qty: 200,
            avgPrice: 1780.0,
            currentPrice: 1800.0,
            unrealizedPnl: 4000.0,
            todayBuyQty: 100,
            todaySellQty: 0,
          },
        ]),
      );

      const adapter = createAdapter();
      const positions = await adapter.fetchPositions();

      expect(positions).toHaveLength(1);
      expect(positions[0]).toEqual({
        exchange: "openctp-sim",
        symbol: "600519.SS",
        side: "long",
        size: 200,
        entryPrice: 1780.0,
        currentPrice: 1800.0,
        unrealizedPnl: 4000.0,
        leverage: 1,
      });
    });

    it("returns empty array when no positions", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));
      const adapter = createAdapter();
      const positions = await adapter.fetchPositions();
      expect(positions).toEqual([]);
    });

    it("filters by symbol", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));
      const adapter = createAdapter();
      await adapter.fetchPositions("600519.SS");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("symbol=600519.SS");
    });
  });

  describe("fetchTicker", () => {
    it("returns ticker data", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          last: 1800.5,
          bid: 1800.0,
          ask: 1801.0,
          volume: 5000000,
          timestamp: 1709500000000,
        }),
      );

      const adapter = createAdapter();
      const ticker = await adapter.fetchTicker("600519.SS");

      expect(ticker).toEqual({
        symbol: "600519.SS",
        last: 1800.5,
        bid: 1800.0,
        ask: 1801.0,
        volume24h: 5000000,
        timestamp: 1709500000000,
      });
    });
  });

  describe("fetchOpenOrders", () => {
    it("returns open orders", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            orderId: "CTP-ORD-003",
            symbol: "000858.SZ",
            side: "buy",
            type: "limit",
            qty: 200,
            filledQty: 0,
            price: 150.0,
            status: "submitted",
            timestamp: 1709500200000,
          },
        ]),
      );

      const adapter = createAdapter();
      const orders = await adapter.fetchOpenOrders();

      expect(orders).toHaveLength(1);
      expect(orders[0]).toEqual({
        orderId: "CTP-ORD-003",
        exchangeId: "openctp-sim",
        symbol: "000858.SZ",
        side: "buy",
        type: "limit",
        amount: 200,
        filledAmount: 0,
        price: 150.0,
        status: "open",
        timestamp: 1709500200000,
      });
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

  describe("CTP status mapping", () => {
    it("maps submitted/partial to open", async () => {
      for (const status of ["submitted", "partial", "未成交", "部分成交"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({ orderId: "o1", status, filledQty: 0, filledPrice: 0, timestamp: Date.now() }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "600519.SS", side: "buy", type: "market", amount: 100,
        });
        expect(result.status).toBe("open");
      }
    });

    it("maps filled/全部成交 to closed", async () => {
      for (const status of ["filled", "全部成交"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({ orderId: "o1", status, filledQty: 100, filledPrice: 1800, timestamp: Date.now() }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "600519.SS", side: "buy", type: "market", amount: 100,
        });
        expect(result.status).toBe("closed");
      }
    });

    it("maps cancelled/已撤单 to canceled", async () => {
      for (const status of ["cancelled", "已撤单"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({ orderId: "o1", status, filledQty: 0, filledPrice: 0, timestamp: Date.now() }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "600519.SS", side: "buy", type: "market", amount: 100,
        });
        expect(result.status).toBe("canceled");
      }
    });

    it("maps rejected/已废单 to rejected", async () => {
      for (const status of ["rejected", "已废单"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({ orderId: "o1", status, filledQty: 0, filledPrice: 0, timestamp: Date.now() }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "600519.SS", side: "buy", type: "market", amount: 100,
        });
        expect(result.status).toBe("rejected");
      }
    });
  });
});
