// Inlined from @openfinclaw/fin-shared-types so this plugin is fully self-contained.

export interface OHLCV {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketType = "crypto" | "equity" | "commodity";

export type MarketRegime = "bull" | "bear" | "sideways" | "volatile" | "crisis";

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
