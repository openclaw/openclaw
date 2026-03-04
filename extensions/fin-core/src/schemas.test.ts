import { describe, expect, it } from "vitest";
import {
  AgentEventSchema,
  AgentEventStatusSchema,
  AgentEventTypeSchema,
  AiChatResponseSchema,
  BacktestAllResponseSchema,
  BalanceSchema,
  CancelOrderToolResponseSchema,
  ConfigStreamDataSchema,
  ErrorResponseSchema,
  EventStreamPayloadSchema,
  EvolutionTriggerResponseSchema,
  ExchangeConfigSchema,
  ExchangeHealthSchema,
  ExchangeListItemSchema,
  MarketTypeSchema,
  OrderResultSchema,
  OrderSideSchema,
  OrderStatusSchema,
  OrderTypeSchema,
  PauseAllResponseSchema,
  PlaceOrderToolResponseSchema,
  PositionSchema,
  RiskEvaluationSchema,
  RiskTierSchema,
  StrategyLevelSchema,
  StrategyStatusSchema,
  TickerDataSchema,
  TradingRiskConfigSchema,
  TradingStreamDataSchema,
} from "./schemas.js";

// ── Enum Schemas ──

describe("enum schemas", () => {
  it("MarketTypeSchema accepts valid values", () => {
    for (const v of ["crypto", "us-equity", "hk-equity"]) {
      expect(MarketTypeSchema.safeParse(v).success).toBe(true);
    }
    expect(MarketTypeSchema.safeParse("forex").success).toBe(false);
  });

  it("OrderSideSchema accepts buy/sell", () => {
    expect(OrderSideSchema.safeParse("buy").success).toBe(true);
    expect(OrderSideSchema.safeParse("sell").success).toBe(true);
    expect(OrderSideSchema.safeParse("short").success).toBe(false);
  });

  it("OrderTypeSchema accepts market/limit", () => {
    expect(OrderTypeSchema.safeParse("market").success).toBe(true);
    expect(OrderTypeSchema.safeParse("limit").success).toBe(true);
    expect(OrderTypeSchema.safeParse("stop").success).toBe(false);
  });

  it("OrderStatusSchema accepts valid statuses", () => {
    for (const v of ["open", "closed", "canceled", "rejected"]) {
      expect(OrderStatusSchema.safeParse(v).success).toBe(true);
    }
    expect(OrderStatusSchema.safeParse("pending").success).toBe(false);
  });

  it("RiskTierSchema accepts auto/confirm/reject", () => {
    for (const v of ["auto", "confirm", "reject"]) {
      expect(RiskTierSchema.safeParse(v).success).toBe(true);
    }
    expect(RiskTierSchema.safeParse("block").success).toBe(false);
  });

  it("StrategyLevelSchema accepts L0-L3", () => {
    for (const v of ["L0_INCUBATE", "L1_BACKTEST", "L2_PAPER", "L3_LIVE"]) {
      expect(StrategyLevelSchema.safeParse(v).success).toBe(true);
    }
    expect(StrategyLevelSchema.safeParse("L4_ALGO").success).toBe(false);
  });

  it("StrategyStatusSchema accepts valid statuses", () => {
    for (const v of ["idle", "running", "paused", "degrading", "stopped"]) {
      expect(StrategyStatusSchema.safeParse(v).success).toBe(true);
    }
  });

  it("AgentEventTypeSchema accepts all event types", () => {
    const types = [
      "trade_executed", "trade_pending", "alert_triggered",
      "strategy_promoted", "strategy_killed", "order_filled",
      "order_cancelled", "emergency_stop", "system",
    ];
    for (const t of types) {
      expect(AgentEventTypeSchema.safeParse(t).success).toBe(true);
    }
    expect(AgentEventTypeSchema.safeParse("unknown_type").success).toBe(false);
  });

  it("AgentEventStatusSchema accepts valid statuses", () => {
    for (const v of ["completed", "pending", "approved", "rejected"]) {
      expect(AgentEventStatusSchema.safeParse(v).success).toBe(true);
    }
  });
});

// ── Core Data Model Schemas ──

describe("TickerDataSchema", () => {
  it("parses valid ticker data", () => {
    const result = TickerDataSchema.safeParse({
      symbol: "BTC/USDT",
      last: 65000,
      bid: 64990,
      ask: 65010,
      volume24h: 1_000_000_000,
      change24hPct: 2.5,
      timestamp: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts minimal ticker (only required fields)", () => {
    const result = TickerDataSchema.safeParse({
      symbol: "ETH/USDT",
      last: 3500,
      timestamp: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(TickerDataSchema.safeParse({ symbol: "BTC/USDT" }).success).toBe(false);
  });
});

describe("BalanceSchema", () => {
  it("parses valid balance", () => {
    const result = BalanceSchema.safeParse({
      exchange: "binance",
      currency: "BTC",
      total: 1.5,
      free: 1.0,
      used: 0.5,
      usdValue: 97500,
    });
    expect(result.success).toBe(true);
  });

  it("accepts balance without usdValue", () => {
    const result = BalanceSchema.safeParse({
      exchange: "binance",
      currency: "USDT",
      total: 5000,
      free: 4000,
      used: 1000,
    });
    expect(result.success).toBe(true);
  });
});

describe("PositionSchema", () => {
  it("parses a full position", () => {
    const result = PositionSchema.safeParse({
      exchange: "binance",
      symbol: "BTC/USDT",
      side: "long",
      size: 2,
      entryPrice: 60000,
      currentPrice: 65000,
      unrealizedPnl: 10000,
      leverage: 3,
      liquidationPrice: 55000,
      marginRatio: 0.15,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid side", () => {
    const result = PositionSchema.safeParse({
      exchange: "binance",
      symbol: "BTC/USDT",
      side: "neutral",
      size: 1,
      entryPrice: 60000,
      currentPrice: 65000,
      unrealizedPnl: 5000,
      leverage: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("OrderResultSchema", () => {
  it("parses a complete order result", () => {
    const result = OrderResultSchema.safeParse({
      orderId: "ord-1",
      exchangeId: "binance-test",
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.1,
      filledAmount: 0.1,
      price: 65000,
      avgFillPrice: 65050,
      status: "closed",
      timestamp: 1700000000000,
      fee: { cost: 0.5, currency: "USDT" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts order without optional fields", () => {
    const result = OrderResultSchema.safeParse({
      orderId: "ord-2",
      exchangeId: "okx",
      symbol: "ETH/USDT",
      side: "sell",
      type: "limit",
      amount: 5,
      filledAmount: 0,
      price: 3500,
      status: "open",
      timestamp: 1700000000000,
    });
    expect(result.success).toBe(true);
  });
});

describe("RiskEvaluationSchema", () => {
  it("parses all tier values", () => {
    for (const tier of ["auto", "confirm", "reject"]) {
      expect(RiskEvaluationSchema.safeParse({ tier }).success).toBe(true);
    }
  });

  it("accepts optional reason and details", () => {
    const result = RiskEvaluationSchema.safeParse({
      tier: "confirm",
      reason: "Trade exceeds auto limit",
      details: { estimatedUsd: 500 },
    });
    expect(result.success).toBe(true);
  });
});

// ── Exchange Config & Health ──

describe("ExchangeConfigSchema", () => {
  it("parses minimal config", () => {
    const result = ExchangeConfigSchema.safeParse({
      exchange: "binance",
      apiKey: "key",
      secret: "secret",
    });
    expect(result.success).toBe(true);
  });

  it("parses full config with all options", () => {
    const result = ExchangeConfigSchema.safeParse({
      exchange: "binance",
      apiKey: "key",
      secret: "secret",
      passphrase: "pass",
      testnet: true,
      subaccount: "sub1",
      defaultType: "swap",
      market: "crypto",
      paper: false,
      host: "localhost",
      port: 11111,
      accountId: "acc-1",
    });
    expect(result.success).toBe(true);
  });
});

describe("ExchangeListItemSchema", () => {
  it("parses valid exchange list item", () => {
    const result = ExchangeListItemSchema.safeParse({
      id: "binance-test",
      exchange: "binance",
      testnet: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("TradingRiskConfigSchema", () => {
  it("parses full risk config", () => {
    const result = TradingRiskConfigSchema.safeParse({
      enabled: true,
      maxAutoTradeUsd: 100,
      confirmThresholdUsd: 900,
      maxDailyLossUsd: 5000,
      maxPositionPct: 25,
      maxLeverage: 5,
      allowedPairs: ["BTC/USDT", "ETH/USDT"],
      blockedPairs: ["DOGE/USDT"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(TradingRiskConfigSchema.safeParse({ enabled: true }).success).toBe(false);
  });
});

describe("ExchangeHealthSchema", () => {
  it("parses valid health data", () => {
    const result = ExchangeHealthSchema.safeParse({
      exchangeId: "binance-test",
      exchangeName: "binance",
      connected: true,
      lastPingMs: 45,
      apiCallsToday: 150,
      apiLimit: 1200,
      lastCheckAt: "2026-03-01T12:00:00Z",
      errorMessage: null,
      consecutiveFailures: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null for lastCheckAt and errorMessage", () => {
    const result = ExchangeHealthSchema.safeParse({
      exchangeId: "okx",
      exchangeName: "okx",
      connected: false,
      lastPingMs: 0,
      apiCallsToday: 0,
      apiLimit: 1200,
      lastCheckAt: null,
      errorMessage: null,
      consecutiveFailures: 0,
    });
    expect(result.success).toBe(true);
  });
});

// ── Agent Event ──

describe("AgentEventSchema", () => {
  it("parses a complete agent event", () => {
    const result = AgentEventSchema.safeParse({
      id: "evt-1",
      type: "trade_executed",
      title: "BUY BTC",
      detail: "Bought 0.1 BTC at $65,000",
      timestamp: 1700000000000,
      status: "completed",
      actionParams: { orderId: "ord-1", symbol: "BTC/USDT" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts event without actionParams", () => {
    const result = AgentEventSchema.safeParse({
      id: "evt-2",
      type: "system",
      title: "Heartbeat",
      detail: "System check passed",
      timestamp: 1700000000000,
      status: "completed",
    });
    expect(result.success).toBe(true);
  });
});

// ── API Response Schemas ──

describe("ErrorResponseSchema", () => {
  it("parses error response", () => {
    expect(ErrorResponseSchema.safeParse({ error: "Something went wrong" }).success).toBe(true);
  });

  it("rejects missing error field", () => {
    expect(ErrorResponseSchema.safeParse({ message: "wrong" }).success).toBe(false);
  });
});

describe("PauseAllResponseSchema", () => {
  it("parses valid response", () => {
    const result = PauseAllResponseSchema.safeParse({ status: "paused_all", count: 3 });
    expect(result.success).toBe(true);
  });

  it("rejects wrong status literal", () => {
    expect(PauseAllResponseSchema.safeParse({ status: "paused", count: 3 }).success).toBe(false);
  });
});

describe("BacktestAllResponseSchema", () => {
  it("parses valid backtest results", () => {
    const result = BacktestAllResponseSchema.safeParse({
      status: "completed",
      results: [
        { id: "s1", name: "SMA Cross", success: true },
        { id: "s2", name: "RSI", success: false, error: "Insufficient data" },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("EvolutionTriggerResponseSchema", () => {
  it("parses minimal trigger response", () => {
    const result = EvolutionTriggerResponseSchema.safeParse({ triggered: true });
    expect(result.success).toBe(true);
  });

  it("parses full trigger response", () => {
    const result = EvolutionTriggerResponseSchema.safeParse({
      triggered: true,
      count: 5,
      strategyId: "s1",
      outcome: "mutated",
      message: "3 strategies evolved",
    });
    expect(result.success).toBe(true);
  });
});

describe("AiChatResponseSchema", () => {
  it("parses valid chat response", () => {
    const result = AiChatResponseSchema.safeParse({
      reply: "BTC is trading at $65,000",
      role: "assistant",
    });
    expect(result.success).toBe(true);
  });

  it("parses with fallback flag", () => {
    const result = AiChatResponseSchema.safeParse({
      reply: "I'm not sure about that",
      role: "assistant",
      fallback: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects wrong role", () => {
    expect(
      AiChatResponseSchema.safeParse({ reply: "test", role: "user" }).success,
    ).toBe(false);
  });
});

// ── Tool Response Schemas (discriminated unions) ──

describe("PlaceOrderToolResponseSchema", () => {
  it("parses success response", () => {
    const result = PlaceOrderToolResponseSchema.safeParse({
      success: true,
      order: {
        orderId: "ord-1",
        exchangeId: "binance",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.1,
        filledAmount: 0.1,
        price: 65000,
        status: "closed",
        timestamp: 1700000000000,
      },
      riskTier: "auto_approved",
      estimatedValueUsd: 6500,
    });
    expect(result.success).toBe(true);
  });

  it("parses failure (blocked) response", () => {
    const result = PlaceOrderToolResponseSchema.safeParse({
      success: false,
      blocked: true,
      reason: "Exceeds threshold",
      estimatedValueUsd: 50000,
    });
    expect(result.success).toBe(true);
  });

  it("parses failure (requires confirmation) response", () => {
    const result = PlaceOrderToolResponseSchema.safeParse({
      success: false,
      requiresConfirmation: true,
      reason: "Medium trade",
      estimatedValueUsd: 500,
      exchange: "binance",
      symbol: "BTC/USDT",
      side: "buy",
      amount: 0.01,
    });
    expect(result.success).toBe(true);
  });
});

describe("CancelOrderToolResponseSchema", () => {
  it("parses success response", () => {
    const result = CancelOrderToolResponseSchema.safeParse({
      success: true,
      message: "Order cancelled",
    });
    expect(result.success).toBe(true);
  });

  it("parses failure response", () => {
    const result = CancelOrderToolResponseSchema.safeParse({
      success: false,
      error: "Order not found",
    });
    expect(result.success).toBe(true);
  });
});

// ── SSE Stream Schemas ──

describe("ConfigStreamDataSchema", () => {
  it("parses config stream data", () => {
    const result = ConfigStreamDataSchema.safeParse({
      exchanges: [{ id: "binance-test", exchange: "binance", testnet: true }],
      riskConfig: {
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 900,
        maxDailyLossUsd: 5000,
        maxPositionPct: 25,
        maxLeverage: 5,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts with plugins field", () => {
    const result = ConfigStreamDataSchema.safeParse({
      exchanges: [],
      riskConfig: {
        enabled: false,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 900,
        maxDailyLossUsd: 5000,
        maxPositionPct: 25,
        maxLeverage: 5,
      },
      plugins: { "fin-paper-trading": { enabled: true } },
    });
    expect(result.success).toBe(true);
  });
});

describe("TradingStreamDataSchema", () => {
  it("parses minimal trading data", () => {
    const result = TradingStreamDataSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("parses full trading data", () => {
    const result = TradingStreamDataSchema.safeParse({
      positions: [{
        exchange: "binance",
        symbol: "BTC/USDT",
        side: "long",
        size: 1,
        entryPrice: 60000,
        currentPrice: 65000,
        unrealizedPnl: 5000,
        leverage: 2,
      }],
      balances: [{
        exchange: "binance",
        currency: "USDT",
        total: 5000,
        free: 4000,
        used: 1000,
      }],
      openOrders: [],
      strategies: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("EventStreamPayloadSchema", () => {
  it("parses initial event payload", () => {
    const result = EventStreamPayloadSchema.safeParse({
      type: "initial",
      events: [{
        id: "e1",
        type: "system",
        title: "Boot",
        detail: "Started",
        timestamp: 1700000000000,
        status: "completed",
      }],
      pendingCount: 0,
    });
    expect(result.success).toBe(true);
  });

  it("parses new_event payload", () => {
    const result = EventStreamPayloadSchema.safeParse({
      type: "new_event",
      event: {
        id: "e2",
        type: "trade_executed",
        title: "BUY ETH",
        detail: "Bought 1 ETH",
        timestamp: 1700000000001,
        status: "completed",
      },
      pendingCount: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown discriminant type", () => {
    const result = EventStreamPayloadSchema.safeParse({
      type: "update",
      events: [],
      pendingCount: 0,
    });
    expect(result.success).toBe(false);
  });
});
