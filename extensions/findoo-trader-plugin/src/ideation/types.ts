/**
 * Types for the Strategy Ideation system.
 * Market scanning → LLM analysis → autonomous strategy generation.
 */

import type { MarketRegime, MarketType } from "../shared/types.js";

/** Technical indicator snapshot for a single symbol. */
export interface SymbolSnapshot {
  symbol: string;
  market: MarketType;
  regime: MarketRegime;
  price: number;
  change24hPct: number;
  indicators: {
    rsi14: number;
    sma50: number;
    sma200: number;
    macdHistogram: number;
    /** Bollinger Band position: 0 = lower band, 1 = upper band. */
    bbPosition: number;
    /** ATR(14) as percentage of current price. */
    atr14Pct: number;
  };
}

/** Aggregated market snapshot across all watched symbols. */
export interface MarketSnapshot {
  timestamp: number;
  symbols: SymbolSnapshot[];
  regimeSummary: Record<string, string[]>;
  crossMarket: {
    cryptoBullishPct: number;
    equityBullishPct: number;
    highVolatilitySymbols: string[];
  };
}

/** LLM-generated strategy hypothesis. */
export interface StrategyHypothesis {
  templateId: string;
  symbol: string;
  timeframe: string;
  parameters: Record<string, number>;
  rationale: string;
  /** Confidence score 0-1. */
  confidence: number;
  /** Custom buy/sell rules (only for templateId === "custom"). */
  rules?: { buy: string; sell: string };
}

/** Result of a single ideation cycle. */
export interface IdeationResult {
  timestamp: number;
  snapshot: MarketSnapshot;
  /** Strategy IDs successfully created. */
  created: string[];
  /** Symbols skipped due to deduplication. */
  skippedDuplicates: string[];
}

/** Configuration for the ideation scheduler. */
export interface IdeationConfig {
  enabled: boolean;
  /** Interval between scans in ms. Default: 86_400_000 (24h). */
  intervalMs: number;
  /** Max strategies to create per cycle. Default: 3. */
  maxStrategiesPerCycle: number;
  watchlist: {
    crypto: string[];
    equity: string[];
  };
}

/** Default watchlist for the ideation scanner. */
export const DEFAULT_WATCHLIST: IdeationConfig["watchlist"] = {
  crypto: [
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    "BNB/USDT",
    "XRP/USDT",
    "ADA/USDT",
    "AVAX/USDT",
    "DOGE/USDT",
    "DOT/USDT",
    "MATIC/USDT",
  ],
  equity: ["SPY", "QQQ", "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "JPM"],
};

/** Default ideation configuration. */
export const DEFAULT_IDEATION_CONFIG: IdeationConfig = {
  enabled: true,
  intervalMs: 86_400_000,
  maxStrategiesPerCycle: 3,
  watchlist: DEFAULT_WATCHLIST,
};
