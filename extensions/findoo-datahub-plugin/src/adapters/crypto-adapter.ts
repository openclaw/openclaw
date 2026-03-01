import type { OHLCVCache } from "../ohlcv-cache.js";
import type { OHLCV, Ticker } from "../types.js";

export type CcxtExchange = {
  fetchTicker: (symbol: string) => Promise<Record<string, unknown>>;
  fetchOHLCV: (
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ) => Promise<Array<[number, number, number, number, number, number]>>;
};

export interface CryptoAdapter {
  getOHLCV(params: {
    symbol: string;
    timeframe: string;
    since?: number;
    limit?: number;
    exchangeId?: string;
  }): Promise<OHLCV[]>;
  getTicker(symbol: string, exchangeId?: string): Promise<Ticker>;
}

export function createCryptoAdapter(
  cache: OHLCVCache,
  getExchangeInstance: (id?: string) => Promise<CcxtExchange>,
  defaultExchangeId?: string,
): CryptoAdapter {
  async function resolveExchange(exchangeId?: string): Promise<CcxtExchange> {
    return getExchangeInstance(exchangeId ?? defaultExchangeId);
  }

  function ccxtToOHLCV(raw: [number, number, number, number, number, number]): OHLCV {
    return {
      timestamp: raw[0],
      open: raw[1],
      high: raw[2],
      low: raw[3],
      close: raw[4],
      volume: raw[5],
    };
  }

  return {
    async getOHLCV(params) {
      const { symbol, timeframe, since, limit, exchangeId } = params;
      const market = "crypto";

      // Check cache for existing data
      const range = cache.getRange(symbol, market, timeframe);

      if (range) {
        // If since + limit are specified and we have enough data in cache, return cached
        if (since != null && limit != null) {
          const cached = cache.query(symbol, market, timeframe, since);
          if (cached.length >= limit) {
            return cached.slice(0, limit);
          }
        }

        // Fetch data after the latest cached timestamp
        const exchange = await resolveExchange(exchangeId);
        const fetchSince = range.latest + 1;
        const raw = await exchange.fetchOHLCV(symbol, timeframe, fetchSince, limit);
        if (raw.length > 0) {
          const newRows = raw.map(ccxtToOHLCV);
          cache.upsertBatch(symbol, market, timeframe, newRows);
        }

        // Return all cached data (including newly stored)
        return cache.query(symbol, market, timeframe, since);
      }

      // Full cache miss — fetch from exchange
      const exchange = await resolveExchange(exchangeId);
      const raw = await exchange.fetchOHLCV(symbol, timeframe, since, limit);
      const rows = raw.map(ccxtToOHLCV);

      if (rows.length > 0) {
        cache.upsertBatch(symbol, market, timeframe, rows);
      }

      return rows;
    },

    async getTicker(symbol, exchangeId) {
      const exchange = await resolveExchange(exchangeId);
      const raw = await exchange.fetchTicker(symbol);

      return {
        symbol,
        market: "crypto",
        last: raw.last as number,
        bid: raw.bid as number | undefined,
        ask: raw.ask as number | undefined,
        volume24h: raw.quoteVolume as number | undefined,
        changePct24h: raw.percentage as number | undefined,
        timestamp: (raw.timestamp as number) ?? Date.now(),
      };
    },
  };
}
