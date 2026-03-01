import type { CryptoAdapter } from "./adapters/crypto-adapter.js";
import type { EquityAdapter } from "./adapters/equity-adapter.js";
import { DataHubClient } from "./datahub-client.js";
import type { OHLCVCache } from "./ohlcv-cache.js";
import type { RegimeDetector } from "./regime-detector.js";
import type { MarketInfo, MarketRegime, MarketType, OHLCV, Ticker } from "./types.js";

/**
 * Unified data provider that routes requests:
 * - Has DataHub API key → DataHub REST (all markets)
 * - No key + crypto → CryptoAdapter (CCXT)
 * - No key + equity → Yahoo Finance adapter
 */
export class UnifiedDataProvider {
  constructor(
    private datahubClient: DataHubClient | null,
    private cryptoAdapter: CryptoAdapter,
    private regimeDetector: RegimeDetector,
    private cache: OHLCVCache,
    private yahooAdapter?: EquityAdapter,
  ) {}

  async getOHLCV(params: {
    symbol: string;
    market: MarketType;
    timeframe: string;
    since?: number;
    limit?: number;
  }): Promise<OHLCV[]> {
    // Route 1: DataHub REST (has API key)
    if (this.datahubClient) {
      // Check cache first
      const range = this.cache.getRange(params.symbol, params.market, params.timeframe);
      if (range && params.since != null && params.limit != null) {
        const cached = this.cache.query(
          params.symbol,
          params.market,
          params.timeframe,
          params.since,
        );
        if (cached.length >= params.limit) {
          return cached.slice(0, params.limit);
        }
      }

      const rows = await this.datahubClient.getOHLCV(params);
      if (rows.length > 0) {
        this.cache.upsertBatch(params.symbol, params.market, params.timeframe, rows);
      }

      // Return from cache for consistency
      if (range || rows.length > 0) {
        const all = this.cache.query(params.symbol, params.market, params.timeframe, params.since);
        return params.limit ? all.slice(0, params.limit) : all;
      }
      return rows;
    }

    // Route 2: Free adapters (no API key)
    if (params.market === "crypto") {
      return this.cryptoAdapter.getOHLCV(params);
    }

    if (params.market === "equity") {
      if (!this.yahooAdapter) {
        throw new Error(
          "Equity data unavailable. Set DATAHUB_API_KEY for full access, or install yahoo-finance2 for free US equity data.",
        );
      }
      return this.yahooAdapter.getOHLCV(params);
    }

    throw new Error(
      `Market "${params.market}" not yet supported in free mode. Set DATAHUB_API_KEY for full access.`,
    );
  }

  async getTicker(symbol: string, market: MarketType): Promise<Ticker> {
    // Route 1: DataHub REST
    if (this.datahubClient) {
      return this.datahubClient.getTicker(symbol, market);
    }

    // Route 2: Free adapters
    if (market === "crypto") {
      return this.cryptoAdapter.getTicker(symbol);
    }

    if (market === "equity") {
      if (!this.yahooAdapter) {
        throw new Error(
          "Equity ticker unavailable. Set DATAHUB_API_KEY or install yahoo-finance2.",
        );
      }
      return this.yahooAdapter.getTicker(symbol);
    }

    throw new Error(`Market "${market}" not yet supported in free mode.`);
  }

  async detectRegime(params: {
    symbol: string;
    market: MarketType;
    timeframe: string;
  }): Promise<MarketRegime> {
    const ohlcv = await this.getOHLCV({
      symbol: params.symbol,
      market: params.market,
      timeframe: params.timeframe,
      limit: 300,
    });
    return this.regimeDetector.detect(ohlcv);
  }

  getSupportedMarkets(): MarketInfo[] {
    const hasFullAccess = !!this.datahubClient;
    return [
      { market: "crypto", symbols: [], available: true },
      { market: "equity", symbols: [], available: hasFullAccess || !!this.yahooAdapter },
      { market: "commodity", symbols: [], available: hasFullAccess },
    ];
  }
}
