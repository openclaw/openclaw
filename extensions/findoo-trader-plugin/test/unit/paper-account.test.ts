import { describe, it, expect, beforeEach } from "vitest";
import { PaperAccount } from "../../src/paper/paper-account.js";

describe("PaperAccount", () => {
  let account: PaperAccount;

  beforeEach(() => {
    account = new PaperAccount({ id: "test-1", name: "Test Account", initialCapital: 10_000 });
  });

  // ── Initial state ──

  it("starts with correct initial state", () => {
    const state = account.getState();
    expect(state.id).toBe("test-1");
    expect(state.name).toBe("Test Account");
    expect(state.initialCapital).toBe(10_000);
    expect(state.cash).toBe(10_000);
    expect(state.equity).toBe(10_000);
    expect(state.positions).toHaveLength(0);
    expect(state.orders).toHaveLength(0);
  });

  // ── Buy execution ──

  describe("executeBuy", () => {
    it("fills buy order and deducts cash", () => {
      const order = account.executeBuy({
        symbol: "BTC/USDT",
        quantity: 0.1,
        fillPrice: 50_000,
        commission: 5,
        slippage: 0,
      });

      expect(order.status).toBe("filled");
      expect(order.side).toBe("buy");
      // Cash = 10000 - (50000*0.1 + 5) = 10000 - 5005 = 4995
      expect(account.getState().cash).toBeCloseTo(4995, 2);
    });

    it("rejects buy when insufficient cash", () => {
      const order = account.executeBuy({
        symbol: "BTC/USDT",
        quantity: 1,
        fillPrice: 50_000,
        commission: 5,
        slippage: 0,
      });

      expect(order.status).toBe("rejected");
      expect(account.getState().cash).toBe(10_000);
      expect(account.getState().positions).toHaveLength(0);
    });

    it("averages into existing position", () => {
      account.executeBuy({
        symbol: "ETH/USDT",
        quantity: 1,
        fillPrice: 3000,
        commission: 0,
        slippage: 0,
      });
      account.executeBuy({
        symbol: "ETH/USDT",
        quantity: 1,
        fillPrice: 4000,
        commission: 0,
        slippage: 0,
      });

      const pos = account.getPosition("ETH/USDT");
      expect(pos).toBeDefined();
      expect(pos!.quantity).toBe(2);
      // Average: (3000*1 + 4000*1) / 2 = 3500
      expect(pos!.entryPrice).toBeCloseTo(3500, 2);
    });

    it("records strategy ID on order", () => {
      const order = account.executeBuy({
        symbol: "BTC/USDT",
        quantity: 0.01,
        fillPrice: 50_000,
        commission: 0,
        slippage: 0,
        strategyId: "strat-abc",
      });
      expect(order.strategyId).toBe("strat-abc");
    });

    it("appends settlement lot when settlableAfter is set", () => {
      const future = Date.now() + 86400_000; // T+1
      account.executeBuy({
        symbol: "SH600000",
        quantity: 100,
        fillPrice: 10,
        commission: 5,
        slippage: 0,
        settlableAfter: future,
      });

      const pos = account.getPosition("SH600000");
      expect(pos!.lots).toHaveLength(1);
      expect(pos!.lots![0]!.settlableAfter).toBe(future);
    });
  });

  // ── Sell execution ──

  describe("executeSell", () => {
    beforeEach(() => {
      account.executeBuy({
        symbol: "BTC/USDT",
        quantity: 0.1,
        fillPrice: 50_000,
        commission: 0,
        slippage: 0,
      });
    });

    it("fills sell order and adds cash", () => {
      const order = account.executeSell({
        symbol: "BTC/USDT",
        quantity: 0.1,
        fillPrice: 55_000,
        commission: 10,
        slippage: 0,
      });

      expect(order.status).toBe("filled");
      // Cash was 5000 after buy, now + (55000*0.1 - 10) = 5000 + 5490 = 10490
      expect(account.getState().cash).toBeCloseTo(10_490, 2);
      // Position closed
      expect(account.getPosition("BTC/USDT")).toBeUndefined();
    });

    it("rejects sell with no position", () => {
      const order = account.executeSell({
        symbol: "DOGE/USDT",
        quantity: 100,
        fillPrice: 0.1,
        commission: 0,
        slippage: 0,
      });
      expect(order.status).toBe("rejected");
    });

    it("rejects sell with insufficient quantity", () => {
      const order = account.executeSell({
        symbol: "BTC/USDT",
        quantity: 1.0, // only have 0.1
        fillPrice: 50_000,
        commission: 0,
        slippage: 0,
      });
      expect(order.status).toBe("rejected");
    });

    it("partial sell reduces position", () => {
      account.executeSell({
        symbol: "BTC/USDT",
        quantity: 0.05,
        fillPrice: 55_000,
        commission: 0,
        slippage: 0,
      });

      const pos = account.getPosition("BTC/USDT");
      expect(pos).toBeDefined();
      expect(pos!.quantity).toBeCloseTo(0.05, 10);
    });

    it("FIFO lot consumption on partial sell", () => {
      // Buy two lots with T+1 settlement
      const t1 = Date.now() + 86400_000;
      const t2 = Date.now() + 2 * 86400_000;

      const acct = new PaperAccount({ id: "t1", name: "T+1", initialCapital: 100_000 });
      acct.executeBuy({
        symbol: "SH600000",
        quantity: 100,
        fillPrice: 10,
        commission: 0,
        slippage: 0,
        settlableAfter: t1,
      });
      acct.executeBuy({
        symbol: "SH600000",
        quantity: 200,
        fillPrice: 11,
        commission: 0,
        slippage: 0,
        settlableAfter: t2,
      });

      // Sell 150 — should consume first lot (100) fully, then 50 from second
      acct.executeSell({
        symbol: "SH600000",
        quantity: 150,
        fillPrice: 12,
        commission: 0,
        slippage: 0,
      });

      const pos = acct.getPosition("SH600000");
      expect(pos!.quantity).toBe(150);
      expect(pos!.lots).toHaveLength(1);
      expect(pos!.lots![0]!.quantity).toBe(150);
    });
  });

  // ── getSellableQuantity (T+1 aware) ──

  describe("getSellableQuantity", () => {
    it("returns full qty when no lots (no settlableAfter)", () => {
      account.executeBuy({
        symbol: "BTC/USDT",
        quantity: 0.5,
        fillPrice: 10_000,
        commission: 0,
        slippage: 0,
      });
      // No lots array → returns position.quantity directly
      expect(account.getSellableQuantity("BTC/USDT")).toBe(0.5);
    });

    it("returns 0 for unsettled lots", () => {
      const future = Date.now() + 86400_000;
      account.executeBuy({
        symbol: "SH600000",
        quantity: 100,
        fillPrice: 10,
        commission: 0,
        slippage: 0,
        settlableAfter: future,
      });
      expect(account.getSellableQuantity("SH600000")).toBe(0);
    });

    it("returns settled quantity only", () => {
      const past = Date.now() - 1000;
      const future = Date.now() + 86400_000;

      account.executeBuy({
        symbol: "SH600000",
        quantity: 100,
        fillPrice: 10,
        commission: 0,
        slippage: 0,
        settlableAfter: past,
      });
      account.executeBuy({
        symbol: "SH600000",
        quantity: 200,
        fillPrice: 10,
        commission: 0,
        slippage: 0,
        settlableAfter: future,
      });

      expect(account.getSellableQuantity("SH600000")).toBe(100);
    });

    it("returns 0 for unknown symbol", () => {
      expect(account.getSellableQuantity("NONEXIST")).toBe(0);
    });
  });

  // ── Price updates & equity ──

  describe("updatePrices / getEquity", () => {
    it("equity reflects current prices", () => {
      account.executeBuy({
        symbol: "BTC/USDT",
        quantity: 0.1,
        fillPrice: 50_000,
        commission: 0,
        slippage: 0,
      });
      // Cash = 5000, position = 0.1 * 50000 = 5000 → equity = 10000

      account.updatePrices({ "BTC/USDT": 60_000 });
      // Cash = 5000, position = 0.1 * 60000 = 6000 → equity = 11000
      expect(account.getEquity()).toBeCloseTo(11_000, 2);
    });

    it("unrealizedPnl updated correctly", () => {
      account.executeBuy({
        symbol: "ETH/USDT",
        quantity: 1,
        fillPrice: 3000,
        commission: 0,
        slippage: 0,
      });
      account.updatePrices({ "ETH/USDT": 3500 });

      const pos = account.getPosition("ETH/USDT");
      expect(pos!.unrealizedPnl).toBeCloseTo(500, 2);
    });

    it("ignores price updates for symbols without positions", () => {
      const equityBefore = account.getEquity();
      account.updatePrices({ "DOGE/USDT": 999 });
      expect(account.getEquity()).toBe(equityBefore);
    });
  });

  // ── Order history ──

  it("getOrderHistory returns only filled orders", () => {
    account.executeBuy({
      symbol: "BTC/USDT",
      quantity: 0.01,
      fillPrice: 50_000,
      commission: 0,
      slippage: 0,
    });
    // This will be rejected (insufficient position)
    account.executeSell({
      symbol: "ETH/USDT",
      quantity: 1,
      fillPrice: 3000,
      commission: 0,
      slippage: 0,
    });

    const history = account.getOrderHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("filled");
  });

  // ── fromState serialization ──

  describe("fromState", () => {
    it("restores account from persisted state", () => {
      account.executeBuy({
        symbol: "BTC/USDT",
        quantity: 0.1,
        fillPrice: 50_000,
        commission: 5,
        slippage: 0,
      });
      account.updatePrices({ "BTC/USDT": 55_000 });

      const state = account.getState();
      const restored = PaperAccount.fromState(state);
      const restoredState = restored.getState();

      expect(restoredState.id).toBe(state.id);
      expect(restoredState.cash).toBe(state.cash);
      expect(restoredState.equity).toBeCloseTo(state.equity, 2);
      expect(restoredState.positions).toHaveLength(1);
      expect(restoredState.orders).toHaveLength(1);
    });

    it("preserves lots through serialization", () => {
      const future = Date.now() + 86400_000;
      account.executeBuy({
        symbol: "SH600000",
        quantity: 100,
        fillPrice: 10,
        commission: 0,
        slippage: 0,
        settlableAfter: future,
      });

      const restored = PaperAccount.fromState(account.getState());
      const pos = restored.getPosition("SH600000");
      expect(pos!.lots).toHaveLength(1);
      expect(pos!.lots![0]!.settlableAfter).toBe(future);
    });
  });
});
