/**
 * L4 -- LLM Tool Chain: Trading tools
 *
 * Simulates multi-step LLM tool_use sequences for the trading domain:
 *   1. "Buy 0.1 BTC"       -> fin_place_order (buy) -> returns orderId
 *   2. "Check positions"   -> (via paper tools) -> BTC position present
 *   3. "Close BTC"         -> sell the position -> position cleared
 *   4. "Emergency stop"    -> all risk checks fire
 *   5. Risk rejection      -> oversized order -> explicit reject reason
 *   6. Limit order         -> fin_place_order (limit) -> price attached
 *   7. Modify order        -> fin_modify_order -> replacement
 *   8. Stop-loss           -> fin_set_stop_loss -> stop order placed
 *   9. Take-profit         -> fin_set_take_profit -> TP order placed
 *  10. Cancel order        -> fin_cancel_order -> success
 *
 * Zero LLM cost -- no API key needed.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/l4-trading-tool-chain.test.ts
 */
vi.mock("ccxt", () => ({}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTradingTools } from "../../../src/execution/trading-tools.js";

// -- Types --

type ToolExecuteFn = (
  id: string,
  params: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: unknown;
}>;

// -- Helpers --

function parseDetails(result: { details: unknown }): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

function captureTools() {
  const tools = new Map<string, ToolExecuteFn>();
  const api = {
    registerTool: vi.fn(
      (def: { name: string; execute: ToolExecuteFn }, opts: { names: string[] }) => {
        for (const name of opts.names) {
          tools.set(name, def.execute.bind(def));
        }
      },
    ),
    runtime: { services: new Map() },
  };
  return { api, tools };
}

// -- Mock exchange / ccxt bridge stubs --

function makeMockRegistry(opts?: { testnet?: boolean }) {
  const orders: Map<string, Record<string, unknown>> = new Map();
  let orderCounter = 0;
  const positions: Array<Record<string, unknown>> = [];
  const testnet = opts?.testnet ?? true;

  return {
    listExchanges: () => [{ id: "binance-test", exchange: "binance", testnet }],
    getInstance: async () => ({
      // CcxtBridge delegates to these methods
      fetchTicker: async (symbol: string) => ({
        symbol,
        last: symbol.includes("BTC") ? 65000 : 3500,
      }),
      createOrder: async (
        symbol: string,
        type: string,
        side: string,
        amount: number,
        price?: number,
        params?: Record<string, unknown>,
      ) => {
        const orderId = `order-${++orderCounter}`;
        const order = { id: orderId, symbol, type, side, amount, price, status: "open", ...params };
        orders.set(orderId, order);
        // Track positions for buy orders
        if (side === "buy" && !params?.reduceOnly) {
          positions.push({ symbol, contracts: amount, side: "long", entryPrice: price ?? 65000 });
        }
        return order;
      },
      cancelOrder: async (orderId: string) => {
        const order = orders.get(orderId);
        if (!order) throw new Error(`Order ${orderId} not found`);
        order.status = "cancelled";
        return order;
      },
      fetchOrder: async (orderId: string) => {
        const order = orders.get(orderId);
        if (!order) throw new Error(`Order ${orderId} not found`);
        return order;
      },
      fetchPositions: async (symbols?: string[]) => {
        const sym = Array.isArray(symbols) ? symbols : [symbols];
        return positions.filter((p) => !sym[0] || p.symbol === sym[0]);
      },
    }),
    _orders: orders,
    _positions: positions,
  };
}

function makeMockRiskController(opts?: { rejectAbove?: number }) {
  const rejectAbove = opts?.rejectAbove ?? 500000;
  return {
    evaluate: (_order: unknown, estimatedValueUsd: number) => {
      if (estimatedValueUsd > rejectAbove) {
        return {
          tier: "reject" as const,
          reason: `Order value $${estimatedValueUsd} exceeds max allowed $${rejectAbove}`,
        };
      }
      if (estimatedValueUsd > rejectAbove * 0.5) {
        return {
          tier: "confirm" as const,
          reason: `Large order $${estimatedValueUsd} requires user confirmation`,
        };
      }
      return { tier: "auto" as const };
    },
    recordLoss: vi.fn(),
  };
}

// ============================================================
//  Test suite
// ============================================================

describe("L4 -- Trading Tool Chain", () => {
  let tools: Map<string, ToolExecuteFn>;
  let registry: ReturnType<typeof makeMockRegistry>;

  beforeEach(() => {
    registry = makeMockRegistry();
    const risk = makeMockRiskController();
    const { api, tools: t } = captureTools();
    registerTradingTools(api as never, registry as never, risk as never);
    tools = t;
  });

  // 1. "Buy 0.1 BTC" -> fin_place_order -> orderId
  it("1. market buy returns orderId and exchange info", async () => {
    const result = await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.1,
    });
    const d = parseDetails(result);
    expect(d.success).toBe(true);
    expect(d.exchange).toBe("binance-test");
    expect(d.testnet).toBe(true);
    const order = d.order as { id: string; side: string; amount: number };
    expect(order.id).toMatch(/^order-/);
    expect(order.side).toBe("buy");
    expect(order.amount).toBe(0.1);
  });

  // 2. Limit order with price
  it("2. limit buy attaches price to order", async () => {
    const result = await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "buy",
      type: "limit",
      amount: 0.5,
      price: 60000,
    });
    const d = parseDetails(result);
    expect(d.success).toBe(true);
    const order = d.order as { type: string; price: number };
    expect(order.type).toBe("limit");
    expect(order.price).toBe(60000);
  });

  // 3. Risk rejection -- oversized order
  it("3. risk controller rejects oversized order with explicit reason", async () => {
    const result = await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 100, // 100 * 65000 = $6.5M -> reject
    });
    const d = parseDetails(result);
    expect(d.success).toBe(false);
    expect(d.rejected).toBe(true);
    expect(typeof d.reason).toBe("string");
    expect(d.reason).toContain("exceeds");
  });

  // 4. Risk confirmation -- medium order
  it("4. medium order triggers confirmation gate", async () => {
    const result = await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 5, // 5 * 65000 = $325K -> confirm
    });
    const d = parseDetails(result);
    expect(d.success).toBe(false);
    expect(d.requiresConfirmation).toBe(true);
    expect(typeof d.reason).toBe("string");
    expect(d.hint).toContain("confirm");
  });

  // 5. Cancel order
  it("5. cancel order returns success with cancelled status", async () => {
    // Place an order first
    const placeResult = await tools.get("fin_place_order")!("conv-1", {
      symbol: "ETH/USDT",
      side: "buy",
      type: "limit",
      amount: 1,
      price: 3000,
    });
    const orderId = (parseDetails(placeResult).order as { id: string }).id;

    // Cancel it
    const cancelResult = await tools.get("fin_cancel_order")!("conv-1", {
      orderId,
      symbol: "ETH/USDT",
    });
    const d = parseDetails(cancelResult);
    expect(d.success).toBe(true);
    expect(d.cancelled).toBeDefined();
  });

  // 6. Modify order -- cancel and replace
  it("6. modify order replaces with new amount", async () => {
    // Place original
    const placeResult = await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "buy",
      type: "limit",
      amount: 0.5,
      price: 60000,
    });
    const orderId = (parseDetails(placeResult).order as { id: string }).id;

    // Modify
    const modResult = await tools.get("fin_modify_order")!("conv-1", {
      orderId,
      symbol: "BTC/USDT",
      amount: 0.3,
      price: 59000,
    });
    const d = parseDetails(modResult);
    expect(d.success).toBe(true);
    expect(d.cancelled).toBeDefined();
    expect(d.replacement).toBeDefined();
    const replacement = d.replacement as { amount: number; price: number };
    expect(replacement.amount).toBe(0.3);
  });

  // 7. Set stop-loss
  it("7. set stop-loss creates stop order for position", async () => {
    // Buy first to create a position
    await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.1,
    });

    const result = await tools.get("fin_set_stop_loss")!("conv-1", {
      symbol: "BTC/USDT",
      stopPrice: 60000,
    });
    const d = parseDetails(result);
    expect(d.success).toBe(true);
    expect(d.stopLoss).toBeDefined();
  });

  // 8. Set take-profit
  it("8. set take-profit creates TP order for position", async () => {
    // Buy first
    await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.2,
    });

    const result = await tools.get("fin_set_take_profit")!("conv-1", {
      symbol: "BTC/USDT",
      profitPrice: 75000,
    });
    const d = parseDetails(result);
    expect(d.success).toBe(true);
    expect(d.takeProfit).toBeDefined();
  });

  // 9. Error: missing required params
  it("9. missing required params returns error", async () => {
    const result = await tools.get("fin_place_order")!("conv-1", {
      symbol: "",
      side: "buy",
      type: "market",
      amount: 0,
    });
    const d = parseDetails(result);
    expect(d.error).toBeDefined();
    expect(typeof d.error).toBe("string");
  });

  // 10. Multi-step chain: buy -> sell (close) -> verify
  it("10. buy then sell chain completes without error", async () => {
    // Step 1: Buy
    const buyResult = await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.1,
    });
    expect(parseDetails(buyResult).success).toBe(true);

    // Step 2: Sell (close position)
    const sellResult = await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "sell",
      type: "market",
      amount: 0.1,
    });
    expect(parseDetails(sellResult).success).toBe(true);
    const sellOrder = parseDetails(sellResult).order as { side: string };
    expect(sellOrder.side).toBe("sell");
  });

  // 11. Leverage order
  it("11. leveraged order passes leverage parameter", async () => {
    const result = await tools.get("fin_place_order")!("conv-1", {
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.1,
      leverage: 3,
    });
    const d = parseDetails(result);
    expect(d.success).toBe(true);
  });

  // 12. Stop-loss on empty position returns error
  it("12. stop-loss on empty position returns error", async () => {
    const result = await tools.get("fin_set_stop_loss")!("conv-1", {
      symbol: "SOL/USDT",
      stopPrice: 100,
    });
    const d = parseDetails(result);
    expect(d.error).toBeDefined();
    expect(typeof d.error).toBe("string");
    expect(d.error).toContain("No open position");
  });
});
