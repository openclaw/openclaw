import type { CryptoAdapter } from "./adapters/crypto-adapter.js";
import type { EquityAdapter } from "./adapters/equity-adapter.js";
import type { RegimeDetector } from "./regime-detector.js";
import type { MarketInfo, MarketRegime, MarketType, OHLCV, Ticker } from "./types.js";

export class UnifiedDataProvider {
  constructor(
    private cryptoAdapter: CryptoAdapter,
    private regimeDetector: RegimeDetector,
    private equityAdapter?: EquityAdapter,
  ) {}

  async getOHLCV(params: {
    symbol: string;
    market: MarketType;
    timeframe: string;
    since?: number;
    limit?: number;
  }): Promise<OHLCV[]> {
    if (params.market === "crypto") {
      return this.cryptoAdapter.getOHLCV(params);
    }
    if (params.market === "equity") {
      if (!this.equityAdapter) {
        throw new Error(
          "Equity adapter not available. Install yahoo-finance2 or load fin-data-hub plugin.",
        );
      }
      return this.equityAdapter.getOHLCV(params);
    }
    throw new Error(`Market "${params.market}" not yet supported.`);
  }

  async getTicker(symbol: string, market: MarketType): Promise<Ticker> {
    if (market === "crypto") {
      return this.cryptoAdapter.getTicker(symbol);
    }
    if (market === "equity") {
      if (!this.equityAdapter) {
        throw new Error(
          "Equity adapter not available. Install yahoo-finance2 or load fin-data-hub plugin.",
        );
      }
      return this.equityAdapter.getTicker(symbol);
    }
    throw new Error(`Market "${market}" not yet supported.`);
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
    return [
      { market: "crypto", symbols: [], available: true },
      { market: "equity", symbols: [], available: !!this.equityAdapter },
      { market: "commodity", symbols: [], available: false },
    ];
  }
}
