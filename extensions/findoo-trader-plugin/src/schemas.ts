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

export const approvalActionSchema = z.object({
  eventId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});
