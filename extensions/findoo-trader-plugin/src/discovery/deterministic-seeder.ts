/**
 * Deterministic Seeder — Phase A of the Strategy Discovery Engine.
 *
 * Maps market regime + technical indicators to strategy templates with
 * fitted parameters. No LLM involved — pure rule-based, O(1) per symbol.
 *
 * Each symbol produces 1 main strategy (following regime) and optionally
 * 1 hedge strategy (counter-regime), capped at maxStrategies total.
 */

import type { MarketType, StrategyDefinition } from "../shared/types.js";
import { createBollingerBands } from "../strategy/builtin-strategies/bollinger-bands.js";
import { createRegimeAdaptive } from "../strategy/builtin-strategies/regime-adaptive.js";
import { createRsiMeanReversion } from "../strategy/builtin-strategies/rsi-mean-reversion.js";
import { createSmaCrossover } from "../strategy/builtin-strategies/sma-crossover.js";
import { createTrendFollowingMomentum } from "../strategy/builtin-strategies/trend-following-momentum.js";
import { createVolatilityMeanReversion } from "../strategy/builtin-strategies/volatility-mean-reversion.js";
import type { DiscoverySymbolSnapshot } from "./types.js";

interface GeneratedStrategy {
  definition: StrategyDefinition;
  role: "main" | "hedge";
}

/**
 * Generate strategy definitions from a market snapshot.
 * Returns up to `maxStrategies` strategies sorted by signal strength.
 */
export function generateFromSnapshot(
  symbols: DiscoverySymbolSnapshot[],
  maxStrategies: number,
): StrategyDefinition[] {
  const candidates: GeneratedStrategy[] = [];

  for (const snap of symbols) {
    const pair = generateForSymbol(snap);
    candidates.push(...pair);
  }

  // Sort: main strategies first, then by signal strength (abs RSI deviation from 50)
  candidates.sort((a, b) => {
    if (a.role !== b.role) return a.role === "main" ? -1 : 1;
    return 0;
  });

  return candidates.slice(0, maxStrategies).map((c) => c.definition);
}

/** Map a single symbol's regime to 1-2 strategy candidates. */
function generateForSymbol(snap: DiscoverySymbolSnapshot): GeneratedStrategy[] {
  const results: GeneratedStrategy[] = [];
  const market = resolveMarketType(snap.market);
  const ts = Date.now();

  // Fit parameters based on technicals
  const params = fitParameters(snap);

  switch (snap.regime) {
    case "bull": {
      // Main: SMA Crossover with fast response
      const main = createSmaCrossover({
        fastPeriod: params.smaFast,
        slowPeriod: params.smaSlow,
        sizePct: params.sizePct,
        symbol: snap.symbol,
      });
      results.push({
        definition: {
          ...main,
          id: `disc-sma-${sanitizeId(snap.symbol)}-${ts}`,
          name: `${snap.symbol} 牛市趋势 SMA ${params.smaFast}/${params.smaSlow}`,
          markets: [market],
        },
        role: "main",
      });

      // Hedge: RSI overbought short hedge
      const hedge = createRsiMeanReversion({
        rsiPeriod: 14,
        overbought: 75,
        oversold: 30,
        sizePct: Math.round(params.sizePct * 0.3),
        symbol: snap.symbol,
      });
      results.push({
        definition: {
          ...hedge,
          id: `disc-rsi-hedge-${sanitizeId(snap.symbol)}-${ts}`,
          name: `${snap.symbol} 牛市回调对冲 RSI`,
          markets: [market],
        },
        role: "hedge",
      });
      break;
    }

    case "bear": {
      // Main: Trend Following with slow periods, short bias
      const main = createTrendFollowingMomentum({
        fastPeriod: params.smaFast + 5,
        slowPeriod: params.smaSlow + 20,
        symbol: snap.symbol,
      });
      results.push({
        definition: {
          ...main,
          id: `disc-trend-bear-${sanitizeId(snap.symbol)}-${ts}`,
          name: `${snap.symbol} 熊市趋势跟踪`,
          markets: [market],
        },
        role: "main",
      });

      // Hedge: Bollinger Bands oversold bounce
      const hedge = createBollingerBands({
        period: 20,
        stdDev: 2,
        sizePct: Math.round(params.sizePct * 0.3),
        symbol: snap.symbol,
      });
      results.push({
        definition: {
          ...hedge,
          id: `disc-bb-hedge-${sanitizeId(snap.symbol)}-${ts}`,
          name: `${snap.symbol} 熊市超卖反弹 BB`,
          markets: [market],
        },
        role: "hedge",
      });
      break;
    }

    case "sideways": {
      // Main: Bollinger Bands range trading
      const main = createBollingerBands({
        period: 20,
        stdDev: 1.5, // narrower for range-bound
        sizePct: params.sizePct,
        symbol: snap.symbol,
      });
      results.push({
        definition: {
          ...main,
          id: `disc-bb-range-${sanitizeId(snap.symbol)}-${ts}`,
          name: `${snap.symbol} 区间震荡 BB 1.5SD`,
          markets: [market],
        },
        role: "main",
      });
      break;
    }

    case "volatile": {
      // Main: Volatility Mean Reversion with wide stops
      const main = createVolatilityMeanReversion({
        atrMultiplier: 2.5,
        lookbackPeriod: 20,
        sizePct: Math.round(params.sizePct * 0.5), // smaller position for high vol
        symbol: snap.symbol,
      });
      results.push({
        definition: {
          ...main,
          id: `disc-volmr-${sanitizeId(snap.symbol)}-${ts}`,
          name: `${snap.symbol} 高波动均值回归`,
          markets: [market],
        },
        role: "main",
      });
      break;
    }

    case "crisis":
    default: {
      // Defensive: Regime Adaptive with conservative params
      const main = createRegimeAdaptive({
        symbol: snap.symbol,
      });
      results.push({
        definition: {
          ...main,
          id: `disc-regime-def-${sanitizeId(snap.symbol)}-${ts}`,
          name: `${snap.symbol} 防御性 Regime Adaptive`,
          markets: [market],
          parameters: {
            ...main.parameters,
            sizePct: Math.round(params.sizePct * 0.2), // minimal position
          },
        },
        role: "main",
      });
      break;
    }
  }

  return results;
}

/** Fit strategy parameters based on technical indicators. */
function fitParameters(snap: DiscoverySymbolSnapshot) {
  // ATR-based position sizing: higher vol → smaller position
  let sizePct = 100;
  if (snap.atrPct > 5) sizePct = 30;
  else if (snap.atrPct > 3) sizePct = 50;
  else if (snap.atrPct > 1.5) sizePct = 70;

  // RSI-adjusted SMA periods
  let smaFast = 10;
  let smaSlow = 30;
  if (snap.rsi14 > 60) {
    smaFast = 8; // faster exit in overbought
    smaSlow = 21;
  } else if (snap.rsi14 < 40) {
    smaFast = 12; // more patience in oversold
    smaSlow = 50;
  }

  // Trend strength: SMA50/SMA200 ratio
  const trendRatio = snap.sma200 > 0 ? snap.sma50 / snap.sma200 : 1;
  if (trendRatio > 1.1) {
    sizePct = Math.min(sizePct + 10, 100); // strong uptrend → slightly larger
  } else if (trendRatio < 0.9) {
    sizePct = Math.max(sizePct - 10, 20); // strong downtrend → smaller
  }

  return { sizePct, smaFast, smaSlow };
}

/** Normalize market type string to MarketType. */
function resolveMarketType(market: string): MarketType {
  if (market === "hk-stock" || market === "a-share") return "equity";
  if (market === "crypto" || market === "equity" || market === "commodity") {
    return market as MarketType;
  }
  return "equity";
}

/** Sanitize symbol for use in strategy IDs. */
function sanitizeId(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]/g, "-");
}
