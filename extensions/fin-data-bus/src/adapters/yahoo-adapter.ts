import type { OHLCVCache } from "../ohlcv-cache.js";
import type { OHLCV, Ticker } from "../types.js";
import type { EquityAdapter } from "./equity-adapter.js";

/**
 * Duck-typed client interface matching yahoo-finance2's API surface.
 * Avoids hard dependency on the yahoo-finance2 package at type level.
 */
export type YahooFinanceClient = {
  chart: (
    symbol: string,
    options: { period1: string | number; period2?: string | number; interval?: string },
  ) => Promise<{ quotes: Array<Record<string, unknown>> }>;
  quote: (symbol: string) => Promise<Record<string, unknown>>;
};

/** Map our canonical timeframes to Yahoo Finance interval strings. */
const TIMEFRAME_MAP: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "60m",
  "4h": "60m", // Yahoo has no 4h; use 1h as fallback
  "1d": "1d",
  "1W": "1wk",
  "1M": "1mo",
};

/** Default lookback in ms (~1 year). */
const DEFAULT_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

/** Convert a Yahoo chart quote row to canonical OHLCV, or null if data is missing. */
function rowToOHLCV(row: Record<string, unknown>): OHLCV | null {
  const date = row.date as Date | undefined;
  if (!date) return null;

  const open = row.open as number | null | undefined;
  const high = row.high as number | null | undefined;
  const low = row.low as number | null | undefined;
  const close = row.close as number | null | undefined;
  const volume = row.volume as number | null | undefined;

  // Yahoo returns null values for non-trading days
  if (open == null || high == null || low == null || close == null) return null;

  return {
    timestamp: date.getTime(),
    open,
    high,
    low,
    close,
    volume: volume ?? 0,
  };
}

export function createYahooAdapter(cache: OHLCVCache, client: YahooFinanceClient): EquityAdapter {
  return {
    async getOHLCV(params) {
      const { symbol, timeframe, since, limit } = params;
      const market = "equity";
      const interval = TIMEFRAME_MAP[timeframe] ?? "1d";

      // Check cache first
      const range = cache.getRange(symbol, market, timeframe);
      if (range) {
        if (since != null && limit != null) {
          const cached = cache.query(symbol, market, timeframe, since);
          if (cached.length >= limit) {
            return cached.slice(0, limit);
          }
        }
      }

      // Determine fetch window
      const period1 = since ?? Date.now() - DEFAULT_LOOKBACK_MS;
      const result = await client.chart(symbol, { period1, interval });

      const rows = result.quotes
        .map(rowToOHLCV)
        .filter((r): r is OHLCV => r !== null)
        .sort((a, b) => a.timestamp - b.timestamp);

      if (rows.length > 0) {
        cache.upsertBatch(symbol, market, timeframe, rows);
      }

      // Return from cache for consistency (merges with any existing data)
      if (range || rows.length > 0) {
        const all = cache.query(symbol, market, timeframe, since);
        return limit ? all.slice(0, limit) : all;
      }
      return rows;
    },

    async getTicker(symbol) {
      const raw = await client.quote(symbol);

      return {
        symbol,
        market: "equity" as const,
        last: (raw.regularMarketPrice as number) ?? 0,
        bid: raw.bid as number | undefined,
        ask: raw.ask as number | undefined,
        volume24h: raw.regularMarketVolume as number | undefined,
        changePct24h: raw.regularMarketChangePercent as number | undefined,
        timestamp: (raw.regularMarketTime as Date)?.getTime?.() ?? Date.now(),
      };
    },
  };
}
