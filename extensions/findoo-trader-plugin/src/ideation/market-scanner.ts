/**
 * MarketScanner — collects OHLCV data and technical indicators for all
 * watched symbols. Uses fin-data-provider (getOHLCV) and fin-regime-detector
 * (detectRegime) via service lookups.
 *
 * Resilient: individual symbol failures are caught via Promise.allSettled.
 */

import type { OHLCV, MarketRegime, MarketType } from "../shared/types.js";
import { buildIndicatorLib } from "../strategy/indicator-lib.js";
import type { MarketSnapshot, SymbolSnapshot, IdeationConfig } from "./types.js";

/** Minimal interface for the data provider service. */
export type DataProviderLike = {
  getOHLCV(params: {
    symbol: string;
    market: MarketType;
    timeframe: string;
    limit?: number;
  }): Promise<OHLCV[]>;
};

/** Minimal interface for the regime detector service. */
export type RegimeDetectorLike = {
  detect(ohlcv: OHLCV[]): MarketRegime;
};

export interface MarketScannerDeps {
  dataProviderResolver: () => DataProviderLike | undefined;
  regimeDetectorResolver: () => RegimeDetectorLike | undefined;
}

export class MarketScanner {
  private deps: MarketScannerDeps;

  constructor(deps: MarketScannerDeps) {
    this.deps = deps;
  }

  /** Scan all watchlist symbols and return an aggregated MarketSnapshot. */
  async scan(config: IdeationConfig): Promise<MarketSnapshot> {
    const dataProvider = this.deps.dataProviderResolver();
    if (!dataProvider) {
      return emptySnapshot();
    }

    const regimeDetector = this.deps.regimeDetectorResolver();

    // Build flat list of { symbol, market }
    const targets: Array<{ symbol: string; market: MarketType }> = [
      ...config.watchlist.crypto.map((s) => ({ symbol: s, market: "crypto" as MarketType })),
      ...config.watchlist.equity.map((s) => ({ symbol: s, market: "equity" as MarketType })),
    ];

    // Fetch OHLCV + compute indicators in parallel
    const results = await Promise.allSettled(
      targets.map(async ({ symbol, market }) => {
        const ohlcv = await dataProvider.getOHLCV({
          symbol,
          market,
          timeframe: "1d",
          limit: 300,
        });
        return buildSymbolSnapshot(symbol, market, ohlcv, regimeDetector);
      }),
    );

    const symbols: SymbolSnapshot[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        symbols.push(r.value);
      }
    }

    return buildMarketSnapshot(symbols);
  }
}

/** Build a SymbolSnapshot from raw OHLCV data. */
function buildSymbolSnapshot(
  symbol: string,
  market: MarketType,
  ohlcv: OHLCV[],
  regimeDetector?: RegimeDetectorLike,
): SymbolSnapshot {
  if (ohlcv.length === 0) {
    return {
      symbol,
      market,
      regime: "sideways",
      price: 0,
      change24hPct: 0,
      indicators: {
        rsi14: 50,
        sma50: 0,
        sma200: 0,
        macdHistogram: 0,
        bbPosition: 0.5,
        atr14Pct: 0,
      },
    };
  }

  const lib = buildIndicatorLib(ohlcv);
  const last = ohlcv.length - 1;
  const price = ohlcv[last]!.close;

  // 24h change
  const prevClose = ohlcv.length >= 2 ? ohlcv[last - 1]!.close : price;
  const change24hPct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

  // Indicators (use last valid value)
  const rsi14Arr = lib.rsi(14);
  const sma50Arr = lib.sma(50);
  const sma200Arr = lib.sma(200);
  const macdResult = lib.macd(12, 26, 9);
  const bbResult = lib.bollingerBands(20, 2);
  const atr14Arr = lib.atr(14);

  const rsi14 = lastValid(rsi14Arr) ?? 50;
  const sma50 = lastValid(sma50Arr) ?? price;
  const sma200 = lastValid(sma200Arr) ?? price;
  const macdHistogram = lastValid(macdResult.histogram) ?? 0;

  // BB position: (close - lower) / (upper - lower), clamped to [0, 1]
  const bbUpper = lastValid(bbResult.upper) ?? price;
  const bbLower = lastValid(bbResult.lower) ?? price;
  const bbRange = bbUpper - bbLower;
  const bbPosition = bbRange > 0 ? Math.max(0, Math.min(1, (price - bbLower) / bbRange)) : 0.5;

  // ATR as % of price
  const atr14 = lastValid(atr14Arr) ?? 0;
  const atr14Pct = price > 0 ? (atr14 / price) * 100 : 0;

  // Regime
  const regime = regimeDetector ? regimeDetector.detect(ohlcv) : "sideways";

  return {
    symbol,
    market,
    regime,
    price,
    change24hPct,
    indicators: { rsi14, sma50, sma200, macdHistogram, bbPosition, atr14Pct },
  };
}

/** Aggregate SymbolSnapshots into a MarketSnapshot. */
function buildMarketSnapshot(symbols: SymbolSnapshot[]): MarketSnapshot {
  const regimeSummary: Record<string, string[]> = {};
  let cryptoBullish = 0;
  let cryptoTotal = 0;
  let equityBullish = 0;
  let equityTotal = 0;
  const highVolatilitySymbols: string[] = [];

  for (const s of symbols) {
    // Regime summary
    if (!regimeSummary[s.regime]) regimeSummary[s.regime] = [];
    regimeSummary[s.regime]!.push(s.symbol);

    // Cross-market stats
    if (s.market === "crypto") {
      cryptoTotal++;
      if (s.regime === "bull") cryptoBullish++;
    } else if (s.market === "equity") {
      equityTotal++;
      if (s.regime === "bull") equityBullish++;
    }

    // High volatility threshold: ATR > 3%
    if (s.indicators.atr14Pct > 3) {
      highVolatilitySymbols.push(s.symbol);
    }
  }

  return {
    timestamp: Date.now(),
    symbols,
    regimeSummary,
    crossMarket: {
      cryptoBullishPct: cryptoTotal > 0 ? (cryptoBullish / cryptoTotal) * 100 : 0,
      equityBullishPct: equityTotal > 0 ? (equityBullish / equityTotal) * 100 : 0,
      highVolatilitySymbols,
    },
  };
}

/** Get the last non-NaN value from an indicator array. */
function lastValid(arr: number[]): number | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!Number.isNaN(arr[i])) return arr[i];
  }
  return undefined;
}

/** Return an empty MarketSnapshot (used when data provider is unavailable). */
function emptySnapshot(): MarketSnapshot {
  return {
    timestamp: Date.now(),
    symbols: [],
    regimeSummary: {},
    crossMarket: { cryptoBullishPct: 0, equityBullishPct: 0, highVolatilitySymbols: [] },
  };
}
