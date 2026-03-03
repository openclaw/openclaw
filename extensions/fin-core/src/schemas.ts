/**
 * fin-core Zod schemas — contract-anchor pattern.
 * All API response types derive from these schemas.
 * Following fin-evolution-engine's established pattern.
 */
import { z } from "zod";

// ── Enums ──

export const MarketTypeSchema = z.enum(["crypto", "us-equity", "hk-equity"]);

export const OrderSideSchema = z.enum(["buy", "sell"]);

export const OrderTypeSchema = z.enum(["market", "limit"]);

export const OrderStatusSchema = z.enum(["open", "closed", "canceled", "rejected"]);

export const RiskTierSchema = z.enum(["auto", "confirm", "reject"]);

export const StrategyLevelSchema = z.enum(["L0_INCUBATE", "L1_BACKTEST", "L2_PAPER", "L3_LIVE"]);

export const StrategyStatusSchema = z.enum(["idle", "running", "paused", "degrading", "stopped"]);

export const AgentEventTypeSchema = z.enum([
  "trade_executed",
  "trade_pending",
  "alert_triggered",
  "strategy_promoted",
  "strategy_killed",
  "order_filled",
  "order_cancelled",
  "emergency_stop",
  "system",
]);

export const AgentEventStatusSchema = z.enum(["completed", "pending", "approved", "rejected"]);

// ── Core Data Models ──

export const TickerDataSchema = z.object({
  symbol: z.string(),
  last: z.number(),
  bid: z.number().optional(),
  ask: z.number().optional(),
  volume24h: z.number().optional(),
  change24hPct: z.number().optional(),
  timestamp: z.number(),
});

export const BalanceSchema = z.object({
  exchange: z.string(),
  currency: z.string(),
  total: z.number(),
  free: z.number(),
  used: z.number(),
  usdValue: z.number().optional(),
});

export const PositionSchema = z.object({
  exchange: z.string(),
  symbol: z.string(),
  side: z.enum(["long", "short"]),
  size: z.number(),
  entryPrice: z.number(),
  currentPrice: z.number(),
  unrealizedPnl: z.number(),
  leverage: z.number(),
  liquidationPrice: z.number().optional(),
  marginRatio: z.number().optional(),
});

export const OrderResultSchema = z.object({
  orderId: z.string(),
  exchangeId: z.string(),
  symbol: z.string(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  amount: z.number(),
  filledAmount: z.number(),
  price: z.number(),
  avgFillPrice: z.number().optional(),
  status: OrderStatusSchema,
  timestamp: z.number(),
  fee: z
    .object({
      cost: z.number(),
      currency: z.string(),
    })
    .optional(),
});

export const RiskEvaluationSchema = z.object({
  tier: RiskTierSchema,
  reason: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// ── Exchange Config ──

export const ExchangeConfigSchema = z.object({
  exchange: z.string(),
  apiKey: z.string(),
  secret: z.string(),
  passphrase: z.string().optional(),
  testnet: z.boolean().optional(),
  subaccount: z.string().optional(),
  defaultType: z.enum(["spot", "swap", "future"]).optional(),
  market: MarketTypeSchema.optional(),
  paper: z.boolean().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  accountId: z.string().optional(),
});

export const ExchangeListItemSchema = z.object({
  id: z.string(),
  exchange: z.string(),
  testnet: z.boolean(),
});

export const TradingRiskConfigSchema = z.object({
  enabled: z.boolean(),
  maxAutoTradeUsd: z.number(),
  confirmThresholdUsd: z.number(),
  maxDailyLossUsd: z.number(),
  maxPositionPct: z.number(),
  maxLeverage: z.number(),
  allowedPairs: z.array(z.string()).optional(),
  blockedPairs: z.array(z.string()).optional(),
});

// ── Exchange Health ──

export const ExchangeHealthSchema = z.object({
  exchangeId: z.string(),
  exchangeName: z.string(),
  connected: z.boolean(),
  lastPingMs: z.number(),
  apiCallsToday: z.number(),
  apiLimit: z.number(),
  lastCheckAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  consecutiveFailures: z.number(),
});

// ── Agent Events ──

export const AgentEventSchema = z.object({
  id: z.string(),
  type: AgentEventTypeSchema,
  title: z.string(),
  detail: z.string(),
  timestamp: z.number(),
  status: AgentEventStatusSchema,
  actionParams: z.record(z.string(), z.unknown()).optional(),
});

// ── API Response Schemas ──

export const ErrorResponseSchema = z.object({
  error: z.string(),
});

/** POST /api/v1/finance/strategies/pause-all */
export const PauseAllResponseSchema = z.object({
  status: z.literal("paused_all"),
  count: z.number(),
});

/** POST /api/v1/finance/strategies/backtest-all */
export const BacktestAllResponseSchema = z.object({
  status: z.literal("completed"),
  results: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      success: z.boolean(),
      error: z.string().optional(),
      result: z.unknown().optional(),
    }),
  ),
});

/** POST /api/v1/finance/evolution/trigger */
export const EvolutionTriggerResponseSchema = z.object({
  triggered: z.literal(true),
  count: z.number().optional(),
  strategyId: z.string().optional(),
  outcome: z.string().optional(),
  results: z.unknown().optional(),
  message: z.string().optional(),
});

/** POST /api/v1/finance/ai/chat */
export const AiChatResponseSchema = z.object({
  reply: z.string(),
  role: z.literal("assistant"),
  fallback: z.boolean().optional(),
});

// ── Tool Response Schemas ──

export const PlaceOrderToolResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    order: OrderResultSchema,
    riskTier: z.literal("auto_approved"),
    estimatedValueUsd: z.number(),
  }),
  z.object({
    success: z.literal(false),
    blocked: z.literal(true).optional(),
    requiresConfirmation: z.literal(true).optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
    estimatedValueUsd: z.number().optional(),
    exchange: z.string().optional(),
    symbol: z.string().optional(),
    side: z.string().optional(),
    amount: z.number().optional(),
  }),
]);

export const CancelOrderToolResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    message: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

// ── SSE Stream Schemas ──

export const ConfigStreamDataSchema = z.object({
  exchanges: z.array(ExchangeListItemSchema),
  riskConfig: TradingRiskConfigSchema,
  plugins: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).optional(),
});

export const TradingStreamDataSchema = z.object({
  positions: z.array(PositionSchema).optional(),
  balances: z.array(BalanceSchema).optional(),
  openOrders: z.array(OrderResultSchema).optional(),
  strategies: z.array(z.unknown()).optional(),
});

export const EventStreamPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("initial"),
    events: z.array(AgentEventSchema),
    pendingCount: z.number(),
  }),
  z.object({
    type: z.literal("new_event"),
    event: AgentEventSchema,
    pendingCount: z.number(),
  }),
]);

// ── Type Exports (derived from schemas) ──

export type TickerDataZ = z.infer<typeof TickerDataSchema>;
export type BalanceZ = z.infer<typeof BalanceSchema>;
export type PositionZ = z.infer<typeof PositionSchema>;
export type OrderResultZ = z.infer<typeof OrderResultSchema>;
export type RiskEvaluationZ = z.infer<typeof RiskEvaluationSchema>;
export type ExchangeHealthZ = z.infer<typeof ExchangeHealthSchema>;
export type AgentEventZ = z.infer<typeof AgentEventSchema>;
