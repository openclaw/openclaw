import { describe, expect, it, vi } from "vitest";
import type { ExchangeConfig, RiskEvaluation } from "../types.js";
import { ExchangeRegistry } from "../exchange-registry.js";
import * as marketRules from "../market-rules.js";
import { RiskController } from "../risk-controller.js";
import { registerTradingTools } from "./trading-tools.js";

// ── Helpers ──

/** Capture registered tools from api.registerTool calls. */
function createToolCapture() {
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
  const api = {
    runtime: { services: new Map() },
    registerTool: vi.fn((def: Record<string, unknown>, _opts: unknown) => {
      tools.set(def.name as string, { execute: def.execute as (id: string, params: Record<string, unknown>) => Promise<unknown> });
    }),
  };
  return { api, tools };
}

function parseToolResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

/** Mock ExchangeRegistry with a fake CCXT instance. */
function mockRegistry(): ExchangeRegistry {
  const reg = new ExchangeRegistry();
  // Manually inject a config so listExchanges() returns something.
  (reg as unknown as { configs: Map<string, ExchangeConfig> }).configs.set("binance-test", {
    exchange: "binance",
    apiKey: "test-key",
    secret: "test-secret",
    testnet: true,
  });
  return reg;
}

function riskEnabled(): RiskController {
  return new RiskController({
    enabled: true,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 900,
    maxDailyLossUsd: 5000,
    maxPositionPct: 25,
    maxLeverage: 5,
  });
}

function riskDisabled(): RiskController {
  return new RiskController({
    enabled: false,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 900,
    maxDailyLossUsd: 5000,
    maxPositionPct: 25,
    maxLeverage: 5,
  });
}

function exchangeConfigs(): Map<string, ExchangeConfig> {
  return new Map([
    [
      "binance-test",
      { exchange: "binance" as const, apiKey: "k", secret: "s", testnet: true },
    ],
  ]);
}

// We need to mock ccxt so CcxtAdapter.ccxt() works.
vi.mock("ccxt", () => {
  return {
    default: {},
    binance: class MockBinance {
      apiKey: string;
      secret: string;
      options: Record<string, unknown>;
      setSandboxMode = vi.fn();

      constructor(opts: Record<string, unknown>) {
        this.apiKey = opts.apiKey as string;
        this.secret = opts.secret as string;
        this.options = (opts.options ?? {}) as Record<string, unknown>;
      }

      // fin_place_order calls fetchTicker + createOrder
      async fetchTicker() {
        return { last: 50000, bid: 49990, ask: 50010, quoteVolume: 1e9, percentage: 1.2, timestamp: Date.now() };
      }

      async createOrder(
        _symbol: string,
        _type: string,
        _side: string,
        _amount: number,
        _price?: number,
      ) {
        return {
          id: "test-ord-1",
          filled: 0,
          price: 50000,
          status: "open",
          timestamp: Date.now(),
        };
      }

      async cancelOrder() {
        return {};
      }
    },
  };
});

describe("trading-tools", () => {
  // ── Registration ──

  it("registers fin_place_order and fin_cancel_order", () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(tools.has("fin_place_order")).toBe(true);
    expect(tools.has("fin_cancel_order")).toBe(true);
  });

  // ── fin_place_order: Risk Tier 1 (auto-execute) ──

  it("fin_place_order auto-executes when estimatedUsd <= maxAutoTradeUsd", async () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    const exec = tools.get("fin_place_order")!.execute;
    // 0.001 BTC * ~50000 = ~$50 → below $100 threshold
    const result = parseToolResult(
      await exec("call-1", {
        exchange: "binance-test",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.001,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.riskTier).toBe("auto_approved");
    expect(result.estimatedValueUsd).toBeGreaterThan(0);
    expect((result.order as Record<string, unknown>).orderId).toBe("test-ord-1");
  });

  // ── fin_place_order: Risk Tier 2 (confirm) ──

  it("fin_place_order requires confirmation for medium trades", async () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    const exec = tools.get("fin_place_order")!.execute;
    // 0.01 BTC * ~50000 = ~$500 → between $100-$900
    const result = parseToolResult(
      await exec("call-2", {
        exchange: "binance-test",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.01,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.estimatedValueUsd).toBeGreaterThan(100);
  });

  // ── fin_place_order: Risk Tier 3 (blocked) ──

  it("fin_place_order blocks large trades", async () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    const exec = tools.get("fin_place_order")!.execute;
    // 1 BTC * ~50000 = ~$50000 → above $900
    const result = parseToolResult(
      await exec("call-3", {
        exchange: "binance-test",
        symbol: "BTC/USDT",
        side: "sell",
        type: "market",
        amount: 1,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("exceeds");
  });

  // ── fin_place_order: Trading disabled ──

  it("fin_place_order rejects when trading is disabled", async () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskDisabled(), exchangeConfigs());

    const exec = tools.get("fin_place_order")!.execute;
    const result = parseToolResult(
      await exec("call-4", {
        exchange: "binance-test",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.001,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("disabled");
  });

  // ── fin_place_order: No exchange configured ──

  it("fin_place_order returns error when exchange not found", async () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    const exec = tools.get("fin_place_order")!.execute;
    const result = parseToolResult(
      await exec("call-5", {
        exchange: "nonexistent",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.1,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });

  // ── fin_place_order: Defaults to first exchange ──

  it("fin_place_order defaults to first exchange when none specified", async () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    const exec = tools.get("fin_place_order")!.execute;
    const result = parseToolResult(
      await exec("call-6", {
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.001,
      }),
    );

    expect(result.success).toBe(true);
  });

  // ── fin_cancel_order ──

  it("fin_cancel_order succeeds for valid exchange", async () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    const exec = tools.get("fin_cancel_order")!.execute;
    const result = parseToolResult(
      await exec("call-7", {
        exchange: "binance-test",
        orderId: "ord-123",
        symbol: "BTC/USDT",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain("cancelled");
  });

  it("fin_cancel_order returns error for unknown exchange", async () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    const exec = tools.get("fin_cancel_order")!.execute;
    const result = parseToolResult(
      await exec("call-8", {
        exchange: "bad-exchange",
        orderId: "ord-123",
        symbol: "BTC/USDT",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });

  // ── fin_place_order: Market closed check ──

  it("fin_place_order blocks when market is closed", async () => {
    const spy = vi.spyOn(marketRules, "isMarketOpen").mockReturnValue(false);
    try {
      const { api, tools } = createToolCapture();
      const reg = mockRegistry();
      registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

      const exec = tools.get("fin_place_order")!.execute;
      const result = parseToolResult(
        await exec("call-mkt-closed", {
          exchange: "binance-test",
          symbol: "BTC/USDT",
          side: "buy",
          type: "market",
          amount: 0.001,
        }),
      );

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("closed");
    } finally {
      spy.mockRestore();
    }
  });

  it("fin_place_order proceeds when market is open (crypto always open)", async () => {
    // Crypto is always open — no mock needed, real isMarketOpen returns true
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    const exec = tools.get("fin_place_order")!.execute;
    const result = parseToolResult(
      await exec("call-mkt-open", {
        exchange: "binance-test",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.001,
      }),
    );

    // Should pass market check and proceed (auto-approved for small amount)
    expect(result.success).toBe(true);
  });

  // ── fin_place_order: Lot size validation ──

  it("fin_place_order blocks invalid lot size", async () => {
    const spy = vi.spyOn(marketRules, "validateLotSize").mockReturnValue({
      valid: false,
      reason: "cn-a-share buy quantity must be a multiple of 100, got 50",
    });
    try {
      const { api, tools } = createToolCapture();
      const reg = mockRegistry();
      registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

      const exec = tools.get("fin_place_order")!.execute;
      const result = parseToolResult(
        await exec("call-lot-bad", {
          exchange: "binance-test",
          symbol: "600519.SS",
          side: "buy",
          type: "limit",
          amount: 50,
          price: 1800,
        }),
      );

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("multiple of 100");
    } finally {
      spy.mockRestore();
    }
  });

  it("fin_place_order allows valid lot size (crypto fractional)", async () => {
    const { api, tools } = createToolCapture();
    const reg = mockRegistry();
    registerTradingTools(api as never, reg, riskEnabled(), exchangeConfigs());

    const exec = tools.get("fin_place_order")!.execute;
    const result = parseToolResult(
      await exec("call-lot-ok", {
        exchange: "binance-test",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.0001,
      }),
    );

    expect(result.success).toBe(true);
  });
});
