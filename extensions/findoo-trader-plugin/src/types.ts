/** Supported exchange identifiers. */
export type ExchangeId =
  | "binance"
  | "okx"
  | "bybit"
  | "bitget"
  | "hyperliquid"
  | "alpaca"
  | "futu"
  | "longport";

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

// === Setting Tab Types ===

/** Request payload for adding a new exchange connection. */
export type AddExchangeRequest = {
  exchange: ExchangeId;
  apiKey: string;
  secret: string;
  passphrase?: string;
  testnet?: boolean;
  label?: string;
};

/** Result of testing an exchange connection. */
export type TestExchangeResult = {
  success: boolean;
  latencyMs: number;
  balance?: { currency: string; free: number; total: number }[];
  markets?: string[];
  error?: string;
};

/** Predefined risk presets. */
export type RiskPreset = {
  name: "conservative" | "balanced" | "aggressive" | "custom";
  maxAutoTradeUsd: number;
  confirmThresholdUsd: number;
  maxDailyLossUsd: number;
  maxPositionPct: number;
  maxLeverage: number;
};

/** Agent behavior configuration. */
export type AgentBehaviorConfig = {
  heartbeatIntervalMs: number;
  discoveryEnabled: boolean;
  evolutionEnabled: boolean;
  mutationRate: number;
  maxConcurrentStrategies: number;
};

/** Notification channel configuration. */
export type NotificationConfig = {
  telegram: { enabled: boolean; chatId?: string };
  discord: { enabled: boolean; webhookUrl?: string };
  email: { enabled: boolean; address?: string };
};

/** Onboarding completion state. */
export type OnboardingState = {
  completed: boolean;
  completedAt?: string;
};

// === Strategy Types ===

/** Request payload for creating a new strategy instance. */
export type CreateStrategyRequest = {
  templateId: string;
  name: string;
  symbol: string;
  timeframe: string;
  exchangeId: string;
  parameters: Record<string, number | string | boolean>;
};

/** Definition of a strategy template. */
export type StrategyTemplate = {
  id: string;
  name: string;
  description: string;
  category: "trend" | "mean-reversion" | "momentum" | "volatility" | "multi-factor";
  parameters: StrategyParameterDef[];
  supportedMarkets: string[];
};

/** Parameter definition within a strategy template. */
export type StrategyParameterDef = {
  name: string;
  type: "number" | "string" | "boolean";
  default: unknown;
  min?: number;
  max?: number;
  description: string;
};

/** Threshold requirements for strategy promotion gates. */
export type GateThreshold = {
  minDays: number;
  minSharpe: number;
  maxDrawdown: number;
  minWinRate: number;
  minTrades: number;
};

/** Promotion gate configuration for L0→L1→L2→L3 pipeline. */
export type PromotionGateConfig = {
  l0l1: GateThreshold;
  l1l2: GateThreshold;
  l2l3: GateThreshold;
};

// === Trader Types ===

/** Trading domain — live, paper, or backtest. */
export type TradingDomain = "live" | "paper" | "backtest";

/** Per-domain trading data wrapper. */
export type TraderDomainData = {
  domain: TradingDomain;
  trading: unknown;
  accounts?: unknown[];
  backtestResults?: unknown[];
};

/** Single OHLCV candlestick bar. */
export type OHLCVBar = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** Level-2 order book snapshot. */
export type OrderBookData = {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
};

// === Overview Types ===

/** Daily market & portfolio brief. */
export type DailyBrief = {
  date: string;
  marketSummary: string;
  portfolioChange: { totalEquity: number; dailyPnl: number; dailyPnlPct: number };
  topStrategy?: { id: string; name: string; dailyReturn: number };
  worstStrategy?: { id: string; name: string; dailyReturn: number };
  alerts: string[];
  recommendation: string;
};

/** Result of an emergency stop action. */
export type EmergencyStopResult = {
  cancelledOrders: number;
  pausedStrategies: number;
  tradingDisabled: boolean;
  timestamp: string;
};

/** Performance attribution breakdown by strategy/market/asset. */
export type PerformanceAttribution = {
  period: string;
  byStrategy: { id: string; name: string; pnl: number; pnlPct: number }[];
  byMarket: { market: string; pnl: number }[];
  byAsset: { symbol: string; pnl: number; trades: number }[];
};

// === Setting Page Aggregate ===

/** Aggregated data for the Settings page. */
export type SettingPageData = {
  exchanges: ExchangeConfig[];
  exchangeHealth: unknown[];
  trading: TradingRiskConfig;
  agent: AgentBehaviorConfig;
  gates: PromotionGateConfig;
  notifications: NotificationConfig;
  onboarding: OnboardingState;
};
