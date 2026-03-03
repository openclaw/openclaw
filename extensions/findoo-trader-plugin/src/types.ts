/** Supported exchange identifiers. */
export type ExchangeId = "hyperliquid" | "binance" | "okx" | "bybit";

/** Credentials and connection config for a single exchange. */
export type ExchangeConfig = {
  exchange: ExchangeId;
  apiKey: string;
  secret: string;
  passphrase?: string;
  testnet?: boolean;
  subaccount?: string;
  /** Default market type. Defaults to "spot". */
  defaultType?: "spot" | "swap" | "future";
};

/** Risk limits for automated trading. */
export type TradingRiskConfig = {
  /** Master switch for trading features. */
  enabled: boolean;
  /** Orders at or below this USD value execute automatically (Tier 1). */
  maxAutoTradeUsd: number;
  /** Orders above maxAutoTradeUsd but at or below this require user confirmation (Tier 2). */
  confirmThresholdUsd: number;
  /** Hard daily loss limit in USD — breaching halts all trading. */
  maxDailyLossUsd: number;
  /** Maximum single-position size as percentage of total portfolio. */
  maxPositionPct: number;
  /** Maximum leverage allowed. */
  maxLeverage: number;
  /** Optional allowlist of trading pairs (empty = all allowed). */
  allowedPairs?: string[];
  /** Optional blocklist of trading pairs. */
  blockedPairs?: string[];
};

/** Top-level financial configuration. */
export type FinancialConfig = {
  exchanges: Record<string, ExchangeConfig>;
  trading: TradingRiskConfig;
  expertSdk?: { apiKey: string; endpoint: string; tier?: "basic" | "pro" | "enterprise" };
  infoFeedSdk?: { apiKey: string; endpoint: string };
};

/** Risk evaluation result from the RiskController. */
export type RiskEvaluation = {
  tier: "auto" | "confirm" | "reject";
  reason?: string;
  details?: Record<string, unknown>;
};

/** Standardized order request. */
export type OrderRequest = {
  exchange: ExchangeId;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  price?: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  reduceOnly?: boolean;
};

/** Standardized position info. */
export type Position = {
  exchange: ExchangeId;
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice?: number;
  marginRatio?: number;
};

/** Standardized balance info. */
export type Balance = {
  exchange: ExchangeId;
  currency: string;
  total: number;
  free: number;
  used: number;
  usdValue?: number;
};
