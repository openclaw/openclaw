// Minimal types for price query plugin.

export interface OHLCV {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketType = "crypto" | "equity";

export interface Ticker {
  symbol: string;
  market: MarketType;
  last: number;
  volume24h?: number;
  timestamp: number;
}
