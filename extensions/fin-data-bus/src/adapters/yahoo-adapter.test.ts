import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OHLCVCache } from "../ohlcv-cache.js";
import type { EquityAdapter } from "./equity-adapter.js";
import type { YahooFinanceClient } from "./yahoo-adapter.js";
import { createYahooAdapter } from "./yahoo-adapter.js";

function makeYahooQuote(date: Date, close: number): Record<string, unknown> {
  return {
    date,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1_000_000,
  };
}

describe("YahooAdapter", () => {
  let dir: string;
  let cache: OHLCVCache;
  let mockClient: YahooFinanceClient;
  let adapter: EquityAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yahoo-adapter-test-"));
    cache = new OHLCVCache(join(dir, "test.sqlite"));

    mockClient = {
      chart: vi.fn(),
      quote: vi.fn(),
    };

    adapter = createYahooAdapter(cache, mockClient);
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getOHLCV", () => {
    it("fetches from Yahoo on cache miss and stores in cache", async () => {
      const d1 = new Date("2025-01-02T00:00:00Z");
      const d2 = new Date("2025-01-03T00:00:00Z");
      const d3 = new Date("2025-01-06T00:00:00Z");

      (mockClient.chart as ReturnType<typeof vi.fn>).mockResolvedValue({
        quotes: [makeYahooQuote(d1, 150), makeYahooQuote(d2, 152), makeYahooQuote(d3, 148)],
      });

      const result = await adapter.getOHLCV({ symbol: "AAPL", timeframe: "1d" });

      expect(result).toHaveLength(3);
      expect(result[0]!.timestamp).toBe(d1.getTime());
      expect(result[0]!.close).toBe(150);
      expect(mockClient.chart).toHaveBeenCalledOnce();

      // Verify data was cached
      const cached = cache.query("AAPL", "equity", "1d");
      expect(cached).toHaveLength(3);
    });

    it("returns cached data without calling Yahoo when cache is complete", async () => {
      const ts1 = new Date("2025-01-02T00:00:00Z").getTime();
      const ts2 = new Date("2025-01-03T00:00:00Z").getTime();

      // Pre-populate cache
      cache.upsertBatch("AAPL", "equity", "1d", [
        { timestamp: ts1, open: 149, high: 151, low: 148, close: 150, volume: 1e6 },
        { timestamp: ts2, open: 151, high: 153, low: 150, close: 152, volume: 1e6 },
      ]);

      const result = await adapter.getOHLCV({
        symbol: "AAPL",
        timeframe: "1d",
        since: ts1,
        limit: 2,
      });

      expect(result).toHaveLength(2);
      expect(mockClient.chart).not.toHaveBeenCalled();
    });

    it("filters out rows with null OHLC values (non-trading days)", async () => {
      const d1 = new Date("2025-01-02T00:00:00Z");
      const d2 = new Date("2025-01-04T00:00:00Z"); // Saturday — null values
      const d3 = new Date("2025-01-06T00:00:00Z");

      (mockClient.chart as ReturnType<typeof vi.fn>).mockResolvedValue({
        quotes: [
          makeYahooQuote(d1, 150),
          { date: d2, open: null, high: null, low: null, close: null, volume: null },
          makeYahooQuote(d3, 148),
        ],
      });

      const result = await adapter.getOHLCV({ symbol: "AAPL", timeframe: "1d" });

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.timestamp)).toEqual([d1.getTime(), d3.getTime()]);
    });

    it("filters out rows with missing date", async () => {
      (mockClient.chart as ReturnType<typeof vi.fn>).mockResolvedValue({
        quotes: [
          makeYahooQuote(new Date("2025-01-02T00:00:00Z"), 150),
          { open: 149, high: 151, low: 148, close: 150, volume: 1e6 }, // no date
        ],
      });

      const result = await adapter.getOHLCV({ symbol: "MSFT", timeframe: "1d" });

      expect(result).toHaveLength(1);
    });

    it("maps timeframe to Yahoo interval", async () => {
      (mockClient.chart as ReturnType<typeof vi.fn>).mockResolvedValue({ quotes: [] });

      await adapter.getOHLCV({ symbol: "AAPL", timeframe: "1h" });

      expect(mockClient.chart).toHaveBeenCalledWith(
        "AAPL",
        expect.objectContaining({ interval: "60m" }),
      );
    });

    it("falls back to 1d for unsupported timeframe", async () => {
      (mockClient.chart as ReturnType<typeof vi.fn>).mockResolvedValue({ quotes: [] });

      await adapter.getOHLCV({ symbol: "AAPL", timeframe: "3h" });

      expect(mockClient.chart).toHaveBeenCalledWith(
        "AAPL",
        expect.objectContaining({ interval: "1d" }),
      );
    });

    it("uses default lookback (~1 year) when since is not provided", async () => {
      (mockClient.chart as ReturnType<typeof vi.fn>).mockResolvedValue({ quotes: [] });

      const before = Date.now();
      await adapter.getOHLCV({ symbol: "AAPL", timeframe: "1d" });
      const after = Date.now();

      const call = (mockClient.chart as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const period1 = call[1].period1 as number;
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;

      expect(period1).toBeGreaterThanOrEqual(before - oneYearMs);
      expect(period1).toBeLessThanOrEqual(after - oneYearMs);
    });

    it("returns empty array when Yahoo returns no quotes", async () => {
      (mockClient.chart as ReturnType<typeof vi.fn>).mockResolvedValue({ quotes: [] });

      const result = await adapter.getOHLCV({ symbol: "XYZ", timeframe: "1d" });

      expect(result).toHaveLength(0);
    });

    it("propagates errors from Yahoo client", async () => {
      (mockClient.chart as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Failed to fetch chart data for INVALID"),
      );

      await expect(adapter.getOHLCV({ symbol: "INVALID", timeframe: "1d" })).rejects.toThrow(
        "Failed to fetch chart data for INVALID",
      );
    });

    it("respects limit parameter", async () => {
      const quotes = Array.from({ length: 10 }, (_, i) =>
        makeYahooQuote(new Date(`2025-01-${String(i + 2).padStart(2, "0")}T00:00:00Z`), 150 + i),
      );

      (mockClient.chart as ReturnType<typeof vi.fn>).mockResolvedValue({ quotes });

      const result = await adapter.getOHLCV({ symbol: "AAPL", timeframe: "1d", limit: 3 });

      expect(result).toHaveLength(3);
    });
  });

  describe("getTicker", () => {
    it("returns a formatted Ticker from Yahoo quote data", async () => {
      const marketTime = new Date("2025-01-06T16:00:00Z");
      (mockClient.quote as ReturnType<typeof vi.fn>).mockResolvedValue({
        regularMarketPrice: 243.85,
        bid: 243.8,
        ask: 243.9,
        regularMarketVolume: 45_000_000,
        regularMarketChangePercent: 1.25,
        regularMarketTime: marketTime,
      });

      const ticker = await adapter.getTicker("AAPL");

      expect(ticker.symbol).toBe("AAPL");
      expect(ticker.market).toBe("equity");
      expect(ticker.last).toBe(243.85);
      expect(ticker.bid).toBe(243.8);
      expect(ticker.ask).toBe(243.9);
      expect(ticker.volume24h).toBe(45_000_000);
      expect(ticker.changePct24h).toBe(1.25);
      expect(ticker.timestamp).toBe(marketTime.getTime());
    });

    it("handles missing optional fields gracefully", async () => {
      (mockClient.quote as ReturnType<typeof vi.fn>).mockResolvedValue({
        regularMarketPrice: 100,
      });

      const ticker = await adapter.getTicker("SPY");

      expect(ticker.last).toBe(100);
      expect(ticker.bid).toBeUndefined();
      expect(ticker.ask).toBeUndefined();
      expect(ticker.volume24h).toBeUndefined();
      expect(ticker.changePct24h).toBeUndefined();
      expect(ticker.timestamp).toBeGreaterThan(0);
    });

    it("throws on Yahoo client failure", async () => {
      (mockClient.quote as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Quote not found: INVALID"),
      );

      await expect(adapter.getTicker("INVALID")).rejects.toThrow("Quote not found: INVALID");
    });
  });
});
