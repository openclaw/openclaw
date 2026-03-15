/**
 * Types for the Strategy Discovery Engine.
 *
 * Phase A: Deterministic seeding from market data (no LLM).
 * Phase B: Subagent-driven deep analysis (sessions_spawn).
 */

import type { MarketType } from "../shared/types.js";

/** Watchlist across multiple markets. */
export interface DiscoveryWatchlist {
  crypto: string[];
  equity: string[];
  hkStock: string[];
  aShare: string[];
}

/** Configuration for a discovery cycle. */
export interface DiscoveryConfig {
  watchlist: DiscoveryWatchlist;
  /** Number of daily K-line bars to fetch per symbol. */
  klineBars: number;
  /** Max strategies to create in Phase A (deterministic). */
  maxDeterministicStrategies: number;
  /** Max strategies for the subagent to create in Phase B. */
  maxLlmStrategies: number;
  /** Whether to fire-and-forget backtests for Phase A strategies. */
  backtestAfterCreate: boolean;
}

/** Default watchlist — covers crypto, US equity, HK stock, A-share. */
export const DEFAULT_DISCOVERY_WATCHLIST: DiscoveryWatchlist = {
  crypto: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
  equity: ["SPY", "AAPL"],
  hkStock: ["0700.HK"],
  aShare: ["600519"],
};

/** Default discovery configuration. */
export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  watchlist: DEFAULT_DISCOVERY_WATCHLIST,
  klineBars: 300,
  maxDeterministicStrategies: 6,
  maxLlmStrategies: 4,
  backtestAfterCreate: true,
};

/** Per-symbol snapshot with regime + technical indicators. */
export interface DiscoverySymbolSnapshot {
  symbol: string;
  market: MarketType | "hk-stock" | "a-share";
  regime: string;
  close: number;
  change7dPct: number;
  change30dPct: number;
  rsi14: number;
  sma50: number;
  sma200: number;
  atrPct: number;
  volume7dAvg: number;
}

/** Aggregated snapshot of all scanned symbols. */
export interface DiscoveryMarketSnapshot {
  timestamp: number;
  symbols: DiscoverySymbolSnapshot[];
}

/** Result of a full discovery cycle (Phase A + Phase B trigger). */
export interface DiscoveryResult {
  snapshot: DiscoveryMarketSnapshot;
  /** Strategy IDs created by Phase A (deterministic). */
  deterministicIds: string[];
  /** Whether Phase B subagent wake was fired. */
  subagentWakeFired: boolean;
}
