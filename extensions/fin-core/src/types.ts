/** Supported CCXT crypto exchange identifiers. */
export type CryptoExchangeId = "hyperliquid" | "binance" | "okx" | "bybit";

/** Supported broker types for traditional markets. */
export type BrokerId = "alpaca" | "futu" | "openctp";

/** Union of all supported exchange/broker identifiers. */
export type ExchangeId = CryptoExchangeId | BrokerId;

/** Market classification. */
export type MarketType = "crypto" | "us-equity" | "hk-equity" | "cn-a-share";

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
  /** Market classification. Inferred from exchange if not set. */
  market?: MarketType;
  /** Alpaca: use paper trading endpoint. */
  paper?: boolean;
  /** Futu: OpenD gateway host. */
  host?: string;
  /** Futu: OpenD gateway port. */
  port?: number;
  /** Futu: trading account ID. */
  accountId?: string;
  /** OpenCTP: broker ID (e.g. "9999" for SimNow). */
  ctpBrokerId?: string;
  /** OpenCTP: CTP gateway address (e.g. "tcp://180.168.146.187:10130"). */
  ctpFrontAddr?: string;
  /** OpenCTP: app ID for authentication. */
  ctpAppId?: string;
  /** OpenCTP: auth code for authentication. */
  ctpAuthCode?: string;
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

/** Standardized order result from exchange. */
export type OrderResult = {
  orderId: string;
  exchangeId: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  filledAmount: number;
  price: number;
  avgFillPrice?: number;
  status: "open" | "closed" | "canceled" | "rejected";
  timestamp: number;
  fee?: { cost: number; currency: string };
};

/** Ticker data from exchange. */
export type TickerData = {
  symbol: string;
  last: number;
  bid?: number;
  ask?: number;
  volume24h?: number;
  change24hPct?: number;
  timestamp: number;
};

const CRYPTO_EXCHANGES: ReadonlySet<string> = new Set<string>([
  "hyperliquid",
  "binance",
  "okx",
  "bybit",
]);

/** Infer MarketType from an ExchangeId or ExchangeConfig. */
export function inferMarketType(exchangeOrConfig: ExchangeId | ExchangeConfig): MarketType {
  if (typeof exchangeOrConfig === "string") {
    if (CRYPTO_EXCHANGES.has(exchangeOrConfig)) return "crypto";
    if (exchangeOrConfig === "alpaca") return "us-equity";
    if (exchangeOrConfig === "futu") return "hk-equity";
    if (exchangeOrConfig === "openctp") return "cn-a-share";
    return "crypto"; // default fallback
  }
  return exchangeOrConfig.market ?? inferMarketType(exchangeOrConfig.exchange);
}

/** Check if an exchange ID is a CCXT crypto exchange. */
export function isCryptoExchange(id: string): id is CryptoExchangeId {
  return CRYPTO_EXCHANGES.has(id);
}
