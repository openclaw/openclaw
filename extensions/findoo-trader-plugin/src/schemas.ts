import { z } from "zod";

// Exchange IDs — must stay in sync with ExchangeId in types.ts
const exchangeIdEnum = z.enum([
  "binance",
  "okx",
  "bybit",
  "bitget",
  "hyperliquid",
  "alpaca",
  "futu",
  "longport",
]);

export const addExchangeSchema = z.object({
  exchange: exchangeIdEnum,
  apiKey: z.string().min(1),
  secret: z.string().min(1),
  passphrase: z.string().optional(),
  testnet: z.boolean().optional().default(false),
  label: z.string().optional(),
});

export const riskConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxAutoTradeUsd: z.number().min(0).max(100000),
    confirmThresholdUsd: z.number().min(0).max(1000000),
    maxDailyLossUsd: z.number().min(0).max(1000000),
    maxPositionPct: z.number().min(1).max(100),
    maxLeverage: z.number().min(1).max(100),
  })
  .refine((d) => d.maxAutoTradeUsd < d.confirmThresholdUsd, {
    message: "maxAutoTradeUsd must be less than confirmThresholdUsd",
  });

export const createStrategySchema = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1).max(100),
  symbol: z.string().min(1),
  timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]),
  exchangeId: z.string().min(1),
  parameters: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});

export const tradingDomainSchema = z.enum(["live", "paper", "backtest"]);

export const gateThresholdSchema = z.object({
  minDays: z.number().int().min(1),
  minSharpe: z.number(),
  maxDrawdown: z.number().max(0),
  minWinRate: z.number().min(0).max(1),
  minTrades: z.number().int().min(1),
});

export const promotionGateSchema = z.object({
  l0l1: gateThresholdSchema,
  l1l2: gateThresholdSchema,
  l2l3: gateThresholdSchema,
});

export const agentBehaviorSchema = z.object({
  heartbeatIntervalMs: z.number().int().min(5000).max(3600000),
  discoveryEnabled: z.boolean(),
  evolutionEnabled: z.boolean(),
  mutationRate: z.number().min(0).max(1),
  maxConcurrentStrategies: z.number().int().min(1).max(50),
});

export const notificationConfigSchema = z.object({
  telegram: z.object({ enabled: z.boolean(), chatId: z.string().optional() }),
  discord: z.object({ enabled: z.boolean(), webhookUrl: z.string().url().optional() }),
  email: z.object({ enabled: z.boolean(), address: z.string().email().optional() }),
});

export const notificationFilterSchema = z.object({
  enabledEvents: z
    .array(
      z.enum([
        "trade_executed",
        "strategy_promoted",
        "strategy_killed",
        "risk_alert",
        "risk_breached",
        "daily_brief",
        "system_error",
        "exchange_disconnected",
        "heartbeat_complete",
      ]),
    )
    .default(["trade_executed", "strategy_promoted", "risk_alert", "daily_brief", "system_error"]),
});

export const configImportSchema = z.object({
  risk: riskConfigSchema.optional(),
  agent: agentBehaviorSchema.optional(),
  gates: promotionGateSchema.optional(),
  notifications: z
    .object({
      telegramBotToken: z.string().optional(),
      telegramChatId: z.string().optional(),
      discordWebhookUrl: z.string().optional(),
      emailHost: z.string().optional(),
      emailPort: z.number().optional(),
      emailFrom: z.string().optional(),
      emailTo: z.string().optional(),
      enabledEvents: notificationFilterSchema.shape.enabledEvents.optional(),
    })
    .optional(),
});

export const approvalActionSchema = z.object({
  eventId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});

/** Zod schema for POST /api/v1/finance/orders — unified order submission. */
export const submitOrderSchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit", "stop-limit"]).default("market"),
  price: z.number().positive().optional(),
  amount: z.number().positive(),
  domain: z.enum(["paper", "live"]).default("paper"),
  /** Paper-only: target account ID (defaults to first account). */
  accountId: z.string().optional(),
  /** Live-only: target exchange ID (defaults to first exchange). */
  exchangeId: z.string().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  /** Pre-approved event ID — skips risk check. */
  approvalId: z.string().optional(),
  reason: z.string().optional(),
  strategyId: z.string().optional(),
});
