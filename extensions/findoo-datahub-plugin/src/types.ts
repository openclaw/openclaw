// Canonical definitions live in @openfinclaw/fin-shared-types.
// Re-exported here for internal use within findoo-datahub-plugin.
import type { MarketType } from "../../fin-shared-types/src/types.js";

export type { OHLCV, MarketType, MarketRegime } from "../../fin-shared-types/src/types.js";

export interface Ticker {
  symbol: string;
  market: MarketType;
  last: number;
  bid?: number;
  ask?: number;
  volume24h?: number;
  changePct24h?: number;
  timestamp: number;
}

export interface MarketInfo {
  market: MarketType;
  symbols: string[];
  available: boolean;
}
