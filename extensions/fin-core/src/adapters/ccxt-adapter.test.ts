import { describe, expect, it, vi } from "vitest";
import { CcxtAdapter } from "./ccxt-adapter.js";

/** Build a fake ExchangeRegistry whose getInstance() returns a mock CCXT exchange. */
function fakeRegistry(mockExchange: Record<string, unknown>) {
  return {
    async getInstance(_id: string) {
      return mockExchange;
    },
  } as never;
}

/** Minimal CCXT-like exchange mock with configurable responses. */
function ccxtExchange(overrides: Record<string, unknown> = {}) {
  return {
    createOrder: vi.fn(async () => ({
      id: "ord-1",
      filled: 0.05,
      price: 65000,
      average: 65100,
      status: "open",
      timestamp: 1700000000000,
      fee: { cost: 0.5, currency: "USDT" },
      ...overrides,
    })),
    cancelOrder: vi.fn(async () => ({})),
    fetchBalance: vi.fn(async () => ({
      total: { BTC: 1.5, USDT: 5000, ETH: 0 },
      free: { BTC: 1.0, USDT: 4000 },
      used: { BTC: 0.5, USDT: 1000 },
    })),
    fetchPositions: vi.fn(async () => [
      {
        symbol: "BTC/USDT",
        side: "long",
        contracts: 2,
        entryPrice: 60000,
        markPrice: 65000,
        unrealizedPnl: 10000,
        leverage: 3,
        liquidationPrice: 55000,
      },
      { symbol: "ETH/USDT", side: "short", contracts: 0 }, // filtered out (0 contracts)
    ]),
    fetchTicker: vi.fn(async () => ({
      last: 65000,
      bid: 64990,
      ask: 65010,
      quoteVolume: 1_000_000_000,
      percentage: 2.5,
      timestamp: 1700000000000,
    })),
    fetchOpenOrders: vi.fn(async () => [
      {
        id: "open-1",
        symbol: "BTC/USDT",
        side: "buy",
        type: "limit",
        amount: 0.1,
        filled: 0,
        price: 60000,
        status: "open",
        timestamp: 1700000000000,
      },
    ]),
  };
}

describe("CcxtAdapter", () => {
  // ── Constructor & Properties ──

  it("sets exchangeId, marketType, and isTestnet", () => {
    const adapter = new CcxtAdapter("binance-test", true, fakeRegistry({}));
    expect(adapter.exchangeId).toBe("binance-test");
    expect(adapter.marketType).toBe("crypto");
    expect(adapter.isTestnet).toBe(true);
  });

  // ── placeOrder ──

  describe("placeOrder", () => {
    it("calls createOrder with correct params and returns normalized result", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      const result = await adapter.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.1,
      });

      expect(mock.createOrder).toHaveBeenCalledWith("BTC/USDT", "market", "buy", 0.1, undefined, {});
      expect(result.orderId).toBe("ord-1");
      expect(result.exchangeId).toBe("bn");
      expect(result.side).toBe("buy");
      expect(result.type).toBe("market");
      expect(result.filledAmount).toBe(0.05);
      expect(result.avgFillPrice).toBe(65100);
      expect(result.status).toBe("open");
      expect(result.fee).toEqual({ cost: 0.5, currency: "USDT" });
    });

    it("passes stopLoss, takeProfit, reduceOnly, and leverage as ccxt params", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      await adapter.placeOrder({
        symbol: "ETH/USDT",
        side: "sell",
        type: "limit",
        amount: 5,
        price: 3500,
        stopLoss: 3000,
        takeProfit: 4000,
        reduceOnly: true,
        leverage: 5,
      });

      const passedParams = mock.createOrder.mock.calls[0][5] as Record<string, unknown>;
      expect(passedParams.stopLoss).toEqual({ triggerPrice: 3000 });
      expect(passedParams.takeProfit).toEqual({ triggerPrice: 4000 });
      expect(passedParams.reduceOnly).toBe(true);
      expect(passedParams.leverage).toBe(5);
    });

    it("maps 'cancelled' status to 'canceled'", async () => {
      const mock = ccxtExchange({ status: "cancelled" });
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      const result = await adapter.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.1,
      });
      expect(result.status).toBe("canceled");
    });

    it("maps 'expired' status to 'canceled'", async () => {
      const mock = ccxtExchange({ status: "expired" });
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      const result = await adapter.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.1,
      });
      expect(result.status).toBe("canceled");
    });

    it("handles missing fee gracefully", async () => {
      const mock = ccxtExchange({ fee: undefined });
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      const result = await adapter.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.1,
      });
      expect(result.fee).toBeUndefined();
    });
  });

  // ── cancelOrder ──

  describe("cancelOrder", () => {
    it("calls exchange.cancelOrder with correct args", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      await adapter.cancelOrder("ord-42", "BTC/USDT");
      expect(mock.cancelOrder).toHaveBeenCalledWith("ord-42", "BTC/USDT");
    });
  });

  // ── fetchBalance ──

  describe("fetchBalance", () => {
    it("returns balances for currencies with total > 0", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      const balances = await adapter.fetchBalance();
      expect(balances).toHaveLength(2); // BTC=1.5, USDT=5000 — ETH=0 filtered
      expect(balances[0]).toMatchObject({
        exchange: "bn",
        currency: "BTC",
        total: 1.5,
        free: 1.0,
        used: 0.5,
      });
      expect(balances[1]).toMatchObject({
        exchange: "bn",
        currency: "USDT",
        total: 5000,
        free: 4000,
        used: 1000,
      });
    });
  });

  // ── fetchPositions ──

  describe("fetchPositions", () => {
    it("returns only positions with contracts > 0", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      const positions = await adapter.fetchPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({
        exchange: "bn",
        symbol: "BTC/USDT",
        side: "long",
        size: 2,
        entryPrice: 60000,
        currentPrice: 65000,
        unrealizedPnl: 10000,
        leverage: 3,
        liquidationPrice: 55000,
      });
    });

    it("passes symbol filter to CCXT", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      await adapter.fetchPositions("BTC/USDT");
      expect(mock.fetchPositions).toHaveBeenCalledWith(["BTC/USDT"]);
    });

    it("passes undefined when no symbol filter", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      await adapter.fetchPositions();
      expect(mock.fetchPositions).toHaveBeenCalledWith(undefined);
    });
  });

  // ── fetchTicker ──

  describe("fetchTicker", () => {
    it("returns normalized ticker data", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      const ticker = await adapter.fetchTicker("BTC/USDT");
      expect(ticker).toMatchObject({
        symbol: "BTC/USDT",
        last: 65000,
        bid: 64990,
        ask: 65010,
        volume24h: 1_000_000_000,
        change24hPct: 2.5,
        timestamp: 1700000000000,
      });
    });
  });

  // ── fetchOpenOrders ──

  describe("fetchOpenOrders", () => {
    it("returns normalized open orders", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      const orders = await adapter.fetchOpenOrders();
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        orderId: "open-1",
        exchangeId: "bn",
        symbol: "BTC/USDT",
        side: "buy",
        type: "limit",
        amount: 0.1,
        filledAmount: 0,
        price: 60000,
        status: "open",
      });
    });
  });

  // ── healthCheck ──

  describe("healthCheck", () => {
    it("returns ok:true when fetchTicker succeeds", async () => {
      const mock = ccxtExchange();
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(mock));

      const health = await adapter.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.error).toBeUndefined();
    });

    it("returns ok:false with error when fetchTicker fails", async () => {
      const failMock = {
        fetchTicker: vi.fn(async () => {
          throw new Error("Connection timeout");
        }),
      };
      const adapter = new CcxtAdapter("bn", false, fakeRegistry(failMock));

      const health = await adapter.healthCheck();
      expect(health.ok).toBe(false);
      expect(health.error).toBe("Connection timeout");
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
