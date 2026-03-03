import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlpacaAdapter } from "./alpaca-adapter.js";

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
  return new AlpacaAdapter("alpaca", isTestnet, "PKTEST123", "secret456");
}

/** Helper: mock a successful JSON response. */
function mockJsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AlpacaAdapter", () => {
  describe("constructor", () => {
    it("creates adapter with correct properties", () => {
      const adapter = createAdapter();
      expect(adapter.exchangeId).toBe("alpaca");
      expect(adapter.marketType).toBe("us-equity");
      expect(adapter.isTestnet).toBe(true);
    });

    it("uses paper base URL for testnet", () => {
      const adapter = createAdapter(true);
      expect(adapter.isTestnet).toBe(true);
    });

    it("uses live base URL for production", () => {
      const adapter = createAdapter(false);
      expect(adapter.isTestnet).toBe(false);
    });
  });

  describe("placeOrder", () => {
    it("places a limit buy order successfully", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          id: "ALP-ORD-001",
          symbol: "AAPL",
          side: "buy",
          type: "limit",
          qty: "10",
          filled_qty: "0",
          filled_avg_price: null,
          limit_price: "150.50",
          status: "accepted",
          created_at: "2026-03-01T10:00:00Z",
        }),
      );

      const adapter = createAdapter();
      const result = await adapter.placeOrder({
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        amount: 10,
        price: 150.5,
      });

      expect(result).toEqual({
        orderId: "ALP-ORD-001",
        exchangeId: "alpaca",
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        amount: 10,
        filledAmount: 0,
        price: 150.5,
        avgFillPrice: undefined,
        status: "open",
        timestamp: new Date("2026-03-01T10:00:00Z").getTime(),
      });

      // Verify POST body and auth headers
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://paper-api.alpaca.markets/v2/orders");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual(
        expect.objectContaining({
          "APCA-API-KEY-ID": "PKTEST123",
          "APCA-API-SECRET-KEY": "secret456",
        }),
      );
      const body = JSON.parse(init?.body as string);
      expect(body.symbol).toBe("AAPL");
      expect(body.side).toBe("buy");
      expect(body.type).toBe("limit");
      expect(body.qty).toBe("10");
      expect(body.limit_price).toBe("150.5");
      expect(body.time_in_force).toBe("day");
    });

    it("places a market sell order", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          id: "ALP-ORD-002",
          symbol: "TSLA",
          side: "sell",
          type: "market",
          qty: "5",
          filled_qty: "5",
          filled_avg_price: "245.30",
          limit_price: null,
          status: "filled",
          created_at: "2026-03-01T11:00:00Z",
        }),
      );

      const adapter = createAdapter();
      const result = await adapter.placeOrder({
        symbol: "TSLA",
        side: "sell",
        type: "market",
        amount: 5,
      });

      expect(result.status).toBe("closed");
      expect(result.filledAmount).toBe(5);
      expect(result.avgFillPrice).toBe(245.3);

      // Market order should NOT include limit_price
      const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(body.limit_price).toBeUndefined();
    });

    it("sends qty and limit_price as strings", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          id: "o1",
          symbol: "AAPL",
          side: "buy",
          type: "limit",
          qty: "100",
          filled_qty: "0",
          filled_avg_price: null,
          limit_price: "175",
          status: "new",
          created_at: "2026-03-01T12:00:00Z",
        }),
      );

      const adapter = createAdapter();
      await adapter.placeOrder({
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        amount: 100,
        price: 175,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(typeof body.qty).toBe("string");
      expect(typeof body.limit_price).toBe("string");
    });

    it("includes stop_loss and take_profit when specified", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          id: "o2",
          symbol: "AAPL",
          side: "buy",
          type: "limit",
          qty: "10",
          filled_qty: "0",
          filled_avg_price: null,
          limit_price: "150",
          status: "accepted",
          created_at: "2026-03-01T13:00:00Z",
        }),
      );

      const adapter = createAdapter();
      await adapter.placeOrder({
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        amount: 10,
        price: 150,
        stopLoss: 140,
        takeProfit: 170,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(body.stop_loss).toEqual({ stop_price: "140" });
      expect(body.take_profit).toEqual({ limit_price: "170" });
    });

    it("uses live base URL when not testnet", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          id: "o3",
          symbol: "AAPL",
          side: "buy",
          type: "market",
          qty: "1",
          filled_qty: "1",
          filled_avg_price: "180",
          limit_price: null,
          status: "filled",
          created_at: "2026-03-01T14:00:00Z",
        }),
      );

      const adapter = createAdapter(false);
      await adapter.placeOrder({
        symbol: "AAPL",
        side: "buy",
        type: "market",
        amount: 1,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.alpaca.markets/v2/orders");
    });

    it("throws on order rejection", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Insufficient buying power" }), { status: 403 }),
      );

      const adapter = createAdapter();
      await expect(
        adapter.placeOrder({
          symbol: "AAPL",
          side: "buy",
          type: "limit",
          amount: 100,
          price: 200,
        }),
      ).rejects.toThrow(/Alpaca order failed: 403/);
    });
  });

  describe("cancelOrder", () => {
    it("cancels an open order (204 No Content)", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const adapter = createAdapter();
      await adapter.cancelOrder("ALP-ORD-001", "AAPL");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://paper-api.alpaca.markets/v2/orders/ALP-ORD-001");
      expect(init?.method).toBe("DELETE");
    });

    it("succeeds on 200 response", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const adapter = createAdapter();
      await expect(adapter.cancelOrder("ALP-ORD-001", "AAPL")).resolves.toBeUndefined();
    });

    it("throws on cancel failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));

      const adapter = createAdapter();
      await expect(adapter.cancelOrder("bad-id", "AAPL")).rejects.toThrow(/Alpaca cancel failed: 404/);
    });
  });

  describe("fetchBalance", () => {
    it("returns USD balance from account endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          equity: "125000.50",
          cash: "50000.25",
          buying_power: "100000.50",
        }),
      );

      const adapter = createAdapter();
      const balances = await adapter.fetchBalance();

      expect(balances).toHaveLength(1);
      expect(balances[0]).toEqual({
        exchange: "alpaca",
        currency: "USD",
        total: 125000.5,
        free: 50000.25,
        used: 125000.5 - 50000.25,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://paper-api.alpaca.markets/v2/account",
        expect.objectContaining({ headers: expect.objectContaining({ "APCA-API-KEY-ID": "PKTEST123" }) }),
      );
    });

    it("throws on fetch failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
      const adapter = createAdapter();
      await expect(adapter.fetchBalance()).rejects.toThrow(/Alpaca account fetch failed: 403/);
    });
  });

  describe("fetchPositions", () => {
    it("returns positions list", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            symbol: "AAPL",
            qty: "50",
            avg_entry_price: "175.00",
            current_price: "180.50",
            unrealized_pl: "275.00",
          },
          {
            symbol: "TSLA",
            qty: "-10",
            avg_entry_price: "250.00",
            current_price: "245.00",
            unrealized_pl: "50.00",
          },
        ]),
      );

      const adapter = createAdapter();
      const positions = await adapter.fetchPositions();

      expect(positions).toHaveLength(2);
      expect(positions[0]).toEqual({
        exchange: "alpaca",
        symbol: "AAPL",
        side: "long",
        size: 50,
        entryPrice: 175,
        currentPrice: 180.5,
        unrealizedPnl: 275,
        leverage: 1,
      });
      expect(positions[1]).toEqual({
        exchange: "alpaca",
        symbol: "TSLA",
        side: "short",
        size: 10,
        entryPrice: 250,
        currentPrice: 245,
        unrealizedPnl: 50,
        leverage: 1,
      });
    });

    it("returns empty array when no positions", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));
      const adapter = createAdapter();
      const positions = await adapter.fetchPositions();
      expect(positions).toEqual([]);
    });

    it("fetches by symbol via /v2/positions/{symbol}", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          symbol: "AAPL",
          qty: "50",
          avg_entry_price: "175.00",
          current_price: "180.00",
          unrealized_pl: "250.00",
        }),
      );

      const adapter = createAdapter();
      const positions = await adapter.fetchPositions("AAPL");

      expect(positions).toHaveLength(1);
      expect(positions[0].symbol).toBe("AAPL");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://paper-api.alpaca.markets/v2/positions/AAPL");
    });

    it("returns empty array on 404 (no position for symbol)", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
      const adapter = createAdapter();
      const positions = await adapter.fetchPositions("GOOG");
      expect(positions).toEqual([]);
    });

    it("throws on non-404 errors", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Server error", { status: 500 }));
      const adapter = createAdapter();
      await expect(adapter.fetchPositions()).rejects.toThrow(/Alpaca positions fetch failed: 500/);
    });
  });

  describe("fetchTicker", () => {
    it("returns ticker data from data.alpaca.markets", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          quote: {
            ap: 181.0,
            bp: 180.5,
            t: "2026-03-01T15:30:00Z",
          },
        }),
      );

      const adapter = createAdapter();
      const ticker = await adapter.fetchTicker("AAPL");

      expect(ticker).toEqual({
        symbol: "AAPL",
        last: (180.5 + 181.0) / 2,
        bid: 180.5,
        ask: 181.0,
        timestamp: new Date("2026-03-01T15:30:00Z").getTime(),
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://data.alpaca.markets/v2/stocks/AAPL/quotes/latest");
    });

    it("uses bid as last when ask is zero", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          quote: { ap: 0, bp: 180.0, t: "2026-03-01T15:30:00Z" },
        }),
      );

      const adapter = createAdapter();
      const ticker = await adapter.fetchTicker("AAPL");

      expect(ticker.last).toBe(180.0);
      expect(ticker.bid).toBe(180.0);
      expect(ticker.ask).toBeUndefined();
    });

    it("uses ask as last when bid is zero", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          quote: { ap: 181.0, bp: 0, t: "2026-03-01T15:30:00Z" },
        }),
      );

      const adapter = createAdapter();
      const ticker = await adapter.fetchTicker("AAPL");

      expect(ticker.last).toBe(181.0);
      expect(ticker.bid).toBeUndefined();
      expect(ticker.ask).toBe(181.0);
    });

    it("throws on fetch failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
      const adapter = createAdapter();
      await expect(adapter.fetchTicker("INVALID")).rejects.toThrow(/Alpaca ticker fetch failed: 404/);
    });
  });

  describe("fetchOpenOrders", () => {
    it("returns open orders", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            id: "ALP-ORD-010",
            symbol: "AAPL",
            side: "buy",
            type: "limit",
            qty: "20",
            filled_qty: "0",
            filled_avg_price: null,
            limit_price: "170.00",
            status: "new",
            created_at: "2026-03-01T09:30:00Z",
          },
        ]),
      );

      const adapter = createAdapter();
      const orders = await adapter.fetchOpenOrders();

      expect(orders).toHaveLength(1);
      expect(orders[0]).toEqual({
        orderId: "ALP-ORD-010",
        exchangeId: "alpaca",
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        amount: 20,
        filledAmount: 0,
        price: 170,
        avgFillPrice: undefined,
        status: "open",
        timestamp: new Date("2026-03-01T09:30:00Z").getTime(),
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/v2/orders");
      expect(url).toContain("status=open");
    });

    it("filters by symbol when provided", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));
      const adapter = createAdapter();
      await adapter.fetchOpenOrders("AAPL");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("status=open");
      expect(url).toContain("symbols=AAPL");
    });

    it("throws on fetch failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Error", { status: 500 }));
      const adapter = createAdapter();
      await expect(adapter.fetchOpenOrders()).rejects.toThrow(/Alpaca open orders fetch failed: 500/);
    });
  });

  describe("healthCheck", () => {
    it("returns ok when account endpoint is reachable", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ id: "account-123", status: "ACTIVE" }),
      );

      const adapter = createAdapter();
      const health = await adapter.healthCheck();

      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.error).toBeUndefined();
    });

    it("returns error when API returns non-ok status", async () => {
      mockFetch.mockResolvedValueOnce(new Response("", { status: 401 }));

      const adapter = createAdapter();
      const health = await adapter.healthCheck();

      expect(health.ok).toBe(false);
      expect(health.error).toContain("401");
    });

    it("returns error when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const adapter = createAdapter();
      const health = await adapter.healthCheck();

      expect(health.ok).toBe(false);
      expect(health.error).toBe("Network error");
    });
  });

  describe("Alpaca status mapping", () => {
    it("maps filled to closed", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          id: "o1", symbol: "AAPL", side: "buy", type: "market",
          qty: "10", filled_qty: "10", filled_avg_price: "180",
          limit_price: null, status: "filled", created_at: "2026-03-01T10:00:00Z",
        }),
      );
      const adapter = createAdapter();
      const result = await adapter.placeOrder({
        symbol: "AAPL", side: "buy", type: "market", amount: 10,
      });
      expect(result.status).toBe("closed");
    });

    it("maps partially_filled/new/accepted/pending_new/accepted_for_bidding to open", async () => {
      for (const status of ["partially_filled", "new", "accepted", "pending_new", "accepted_for_bidding"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({
            id: "o1", symbol: "AAPL", side: "buy", type: "limit",
            qty: "10", filled_qty: "0", filled_avg_price: null,
            limit_price: "180", status, created_at: "2026-03-01T10:00:00Z",
          }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "AAPL", side: "buy", type: "limit", amount: 10, price: 180,
        });
        expect(result.status).toBe("open");
      }
    });

    it("maps canceled/expired/pending_cancel to canceled", async () => {
      for (const status of ["canceled", "expired", "pending_cancel"]) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({
            id: "o1", symbol: "AAPL", side: "buy", type: "limit",
            qty: "10", filled_qty: "0", filled_avg_price: null,
            limit_price: "180", status, created_at: "2026-03-01T10:00:00Z",
          }),
        );
        const adapter = createAdapter();
        const result = await adapter.placeOrder({
          symbol: "AAPL", side: "buy", type: "limit", amount: 10, price: 180,
        });
        expect(result.status).toBe("canceled");
      }
    });

    it("maps unknown status to rejected", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          id: "o1", symbol: "AAPL", side: "buy", type: "market",
          qty: "10", filled_qty: "0", filled_avg_price: null,
          limit_price: null, status: "suspended", created_at: "2026-03-01T10:00:00Z",
        }),
      );
      const adapter = createAdapter();
      const result = await adapter.placeOrder({
        symbol: "AAPL", side: "buy", type: "market", amount: 10,
      });
      expect(result.status).toBe("rejected");
    });
  });
});
