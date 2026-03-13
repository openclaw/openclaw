import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ExchangeConfig, TradingRiskConfig } from "./types.js";

export type FindooTraderConfig = {
  /** Findoo Trader license key. Undefined when not configured. */
  apiKey: string | undefined;
  /** True when the resolved API key is the built-in dev key (not production-safe). */
  usingDevKey: boolean;
  exchanges: Record<string, ExchangeConfig>;
  riskConfig: TradingRiskConfig;
};

// Built-in dev key for testing — will be removed before production release.
const DEV_API_KEY = "ft-d0453f8a-5024-4a4c-b2aa-9dc4f9d45f75";

const DEFAULT_RISK_CONFIG: TradingRiskConfig = {
  enabled: false,
  maxAutoTradeUsd: 100,
  confirmThresholdUsd: 500,
  maxDailyLossUsd: 1000,
  maxPositionPct: 25,
  maxLeverage: 1,
};

/**
 * Resolve trader config from plugin config > env vars > api.config.financial > defaults.
 * Follows the same pattern as findoo-datahub-plugin resolveConfig().
 */
export function resolveConfig(api: OpenClawPluginApi): FindooTraderConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;
  const financialConfig = api.config?.financial as Record<string, unknown> | undefined;

  // License key: pluginConfig > env var > built-in dev key (for testing)
  // In production, do NOT fall back to DEV_API_KEY
  const isProduction = process.env.NODE_ENV === "production";
  const configuredKey =
    (typeof raw?.apiKey === "string" && raw.apiKey.trim()) ||
    process.env.FINDOO_TRADER_API_KEY ||
    process.env.OPENFINCLAW_TRADER_API_KEY ||
    undefined;
  const apiKey = configuredKey ?? (isProduction ? undefined : DEV_API_KEY);
  const usingDevKey = !configuredKey && apiKey === DEV_API_KEY;

  // Exchanges: pluginConfig > financial config > empty
  const exchanges =
    (raw?.exchanges as Record<string, ExchangeConfig> | undefined) ??
    (financialConfig?.exchanges as Record<string, ExchangeConfig> | undefined) ??
    {};

  // Risk config: merge pluginConfig.trading > financial.trading > defaults
  const tradingCfg =
    (raw?.trading as Partial<TradingRiskConfig> | undefined) ??
    (financialConfig?.trading as Partial<TradingRiskConfig> | undefined) ??
    {};

  const riskConfig: TradingRiskConfig = {
    ...DEFAULT_RISK_CONFIG,
    ...(tradingCfg.enabled != null && { enabled: tradingCfg.enabled }),
    ...(tradingCfg.maxAutoTradeUsd != null && { maxAutoTradeUsd: tradingCfg.maxAutoTradeUsd }),
    ...(tradingCfg.confirmThresholdUsd != null && {
      confirmThresholdUsd: tradingCfg.confirmThresholdUsd,
    }),
    ...(tradingCfg.maxDailyLossUsd != null && { maxDailyLossUsd: tradingCfg.maxDailyLossUsd }),
    ...(tradingCfg.maxPositionPct != null && { maxPositionPct: tradingCfg.maxPositionPct }),
    ...(tradingCfg.maxLeverage != null && { maxLeverage: tradingCfg.maxLeverage }),
    ...(tradingCfg.allowedPairs && { allowedPairs: tradingCfg.allowedPairs }),
    ...(tradingCfg.blockedPairs && { blockedPairs: tradingCfg.blockedPairs }),
  };

  // Auto-discover exchanges from environment variables
  // BINANCE_TESTNET_API_KEY + BINANCE_TESTNET_SECRET → auto-register "binance-testnet"
  if (
    !exchanges["binance-testnet"] &&
    process.env.BINANCE_TESTNET_API_KEY &&
    process.env.BINANCE_TESTNET_SECRET
  ) {
    exchanges["binance-testnet"] = {
      exchange: "binance",
      apiKey: process.env.BINANCE_TESTNET_API_KEY,
      secret: process.env.BINANCE_TESTNET_SECRET,
      testnet: true,
      defaultType: "spot",
    };
  }

  return { apiKey, usingDevKey, exchanges, riskConfig };
}
