import type { OHLCV, Ticker } from "../types.js";

export interface EquityAdapter {
  getOHLCV(params: {
    symbol: string;
    timeframe: string;
    since?: number;
    limit?: number;
  }): Promise<OHLCV[]>;
  getTicker(symbol: string): Promise<Ticker>;
}
