import { describe, it, expect, vi } from "vitest";
import { MarketScanner } from "../../src/ideation/market-scanner.js";
import type { OHLCV, MarketRegime } from "../../src/shared/types.js";

/** Generate synthetic OHLCV bars. */
function makeBars(count: number, basePrice = 100): OHLCV[] {
  const bars: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    const price = basePrice + Math.sin(i * 0.1) * 10;
    bars.push({
      timestamp: Date.now() - (count - i) * 86_400_000,
      open: price - 1,
      high: price + 2,
      low: price - 2,
      close: price,
      volume: 1000 + i * 10,
    });
  }
  return bars;
}

describe("MarketScanner", () => {
  it("returns empty snapshot when no data provider", async () => {
    const scanner = new MarketScanner({
      dataProviderResolver: () => undefined,
      regimeDetectorResolver: () => undefined,
    });

    const snapshot = await scanner.scan({
      enabled: true,
      intervalMs: 86_400_000,
      maxStrategiesPerCycle: 3,
      watchlist: { crypto: ["BTC/USDT"], equity: ["SPY"] },
    });

    expect(snapshot.symbols).toHaveLength(0);
    expect(snapshot.crossMarket.cryptoBullishPct).toBe(0);
  });

  it("scans symbols and computes indicators", async () => {
    const bars = makeBars(300, 50000);
    const getOHLCV = vi.fn().mockResolvedValue(bars);
    const detect = vi.fn().mockReturnValue("bull" as MarketRegime);

    const scanner = new MarketScanner({
      dataProviderResolver: () => ({ getOHLCV }),
      regimeDetectorResolver: () => ({ detect }),
    });

    const snapshot = await scanner.scan({
      enabled: true,
      intervalMs: 86_400_000,
      maxStrategiesPerCycle: 3,
      watchlist: { crypto: ["BTC/USDT", "ETH/USDT"], equity: ["SPY"] },
    });

    expect(snapshot.symbols).toHaveLength(3);
    expect(getOHLCV).toHaveBeenCalledTimes(3);
    expect(detect).toHaveBeenCalledTimes(3);

    // Verify indicator structure
    const btc = snapshot.symbols[0]!;
    expect(btc.symbol).toBe("BTC/USDT");
    expect(btc.market).toBe("crypto");
    expect(btc.regime).toBe("bull");
    expect(btc.price).toBeGreaterThan(0);
    expect(btc.indicators.rsi14).toBeGreaterThanOrEqual(0);
    expect(btc.indicators.rsi14).toBeLessThanOrEqual(100);
    expect(typeof btc.indicators.sma50).toBe("number");
    expect(typeof btc.indicators.sma200).toBe("number");
    expect(typeof btc.indicators.macdHistogram).toBe("number");
    expect(btc.indicators.bbPosition).toBeGreaterThanOrEqual(0);
    expect(btc.indicators.bbPosition).toBeLessThanOrEqual(1);
    expect(btc.indicators.atr14Pct).toBeGreaterThanOrEqual(0);
  });

  it("builds regime summary and cross-market stats", async () => {
    const bars = makeBars(300);
    const getOHLCV = vi.fn().mockResolvedValue(bars);
    let callIdx = 0;
    const regimes: MarketRegime[] = ["bull", "bear", "bull"];
    const detect = vi.fn().mockImplementation(() => regimes[callIdx++] ?? "sideways");

    const scanner = new MarketScanner({
      dataProviderResolver: () => ({ getOHLCV }),
      regimeDetectorResolver: () => ({ detect }),
    });

    const snapshot = await scanner.scan({
      enabled: true,
      intervalMs: 86_400_000,
      maxStrategiesPerCycle: 3,
      watchlist: { crypto: ["BTC/USDT", "ETH/USDT"], equity: ["SPY"] },
    });

    expect(snapshot.regimeSummary.bull).toContain("BTC/USDT");
    expect(snapshot.regimeSummary.bull).toContain("SPY");
    expect(snapshot.regimeSummary.bear).toContain("ETH/USDT");
    // 1 out of 2 crypto is bullish = 50%
    expect(snapshot.crossMarket.cryptoBullishPct).toBe(50);
    // 1 out of 1 equity is bullish = 100%
    expect(snapshot.crossMarket.equityBullishPct).toBe(100);
  });

  it("tolerates individual symbol failures via allSettled", async () => {
    let callIdx = 0;
    const getOHLCV = vi.fn().mockImplementation(async () => {
      callIdx++;
      if (callIdx === 2) throw new Error("API rate limit");
      return makeBars(300);
    });

    const scanner = new MarketScanner({
      dataProviderResolver: () => ({ getOHLCV }),
      regimeDetectorResolver: () => undefined,
    });

    const snapshot = await scanner.scan({
      enabled: true,
      intervalMs: 86_400_000,
      maxStrategiesPerCycle: 3,
      watchlist: { crypto: ["BTC/USDT", "ETH/USDT", "SOL/USDT"], equity: [] },
    });

    // 1 out of 3 failed → 2 symbols in snapshot
    expect(snapshot.symbols).toHaveLength(2);
  });

  it("handles empty OHLCV gracefully", async () => {
    const getOHLCV = vi.fn().mockResolvedValue([]);

    const scanner = new MarketScanner({
      dataProviderResolver: () => ({ getOHLCV }),
      regimeDetectorResolver: () => undefined,
    });

    const snapshot = await scanner.scan({
      enabled: true,
      intervalMs: 86_400_000,
      maxStrategiesPerCycle: 3,
      watchlist: { crypto: ["BTC/USDT"], equity: [] },
    });

    expect(snapshot.symbols).toHaveLength(1);
    const btc = snapshot.symbols[0]!;
    expect(btc.price).toBe(0);
    expect(btc.regime).toBe("sideways");
    expect(btc.indicators.rsi14).toBe(50);
  });

  it("detects high volatility symbols (ATR > 3%)", async () => {
    // Create highly volatile bars (large high-low ranges)
    const bars: OHLCV[] = [];
    for (let i = 0; i < 300; i++) {
      const price = 100;
      bars.push({
        timestamp: Date.now() - (300 - i) * 86_400_000,
        open: price,
        high: price + 10, // 10% range → very high ATR
        low: price - 10,
        close: price,
        volume: 1000,
      });
    }

    const getOHLCV = vi.fn().mockResolvedValue(bars);
    const scanner = new MarketScanner({
      dataProviderResolver: () => ({ getOHLCV }),
      regimeDetectorResolver: () => undefined,
    });

    const snapshot = await scanner.scan({
      enabled: true,
      intervalMs: 86_400_000,
      maxStrategiesPerCycle: 3,
      watchlist: { crypto: ["DOGE/USDT"], equity: [] },
    });

    expect(snapshot.crossMarket.highVolatilitySymbols).toContain("DOGE/USDT");
  });
});
