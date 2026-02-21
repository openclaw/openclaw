import type { AccountInfo, BrokerProvider, Position, Quote } from "../types.js";

// =============================================================================
// Mock Broker Provider — returns fictional data for development/testing
// =============================================================================

const MOCK_POSITIONS: Position[] = [
  {
    symbol: "AAPL",
    qty: 10,
    marketValue: 1_890.0,
    avgEntryPrice: 175.0,
    currentPrice: 189.0,
    unrealizedPL: 140.0,
    unrealizedPLPercent: 8.0,
  },
  {
    symbol: "MSFT",
    qty: 5,
    marketValue: 2_100.0,
    avgEntryPrice: 390.0,
    currentPrice: 420.0,
    unrealizedPL: 150.0,
    unrealizedPLPercent: 7.69,
  },
  {
    symbol: "BTC/USD",
    qty: 0.5,
    marketValue: 25_000.0,
    avgEntryPrice: 45_000.0,
    currentPrice: 50_000.0,
    unrealizedPL: 2_500.0,
    unrealizedPLPercent: 11.11,
  },
];

const MOCK_QUOTES: Record<string, Quote> = {
  AAPL: { symbol: "AAPL", lastPrice: 189.0, change: 2.5, changePercent: 1.34, volume: 52_431_000 },
  MSFT: {
    symbol: "MSFT",
    lastPrice: 420.0,
    change: -1.2,
    changePercent: -0.28,
    volume: 21_890_000,
  },
  "BTC/USD": {
    symbol: "BTC/USD",
    lastPrice: 50_000.0,
    change: 1_200.0,
    changePercent: 2.46,
    volume: 18_200,
  },
  TSLA: { symbol: "TSLA", lastPrice: 245.0, change: 5.3, changePercent: 2.21, volume: 98_200_000 },
  GOOGL: {
    symbol: "GOOGL",
    lastPrice: 155.0,
    change: -0.8,
    changePercent: -0.51,
    volume: 28_100_000,
  },
};

export class MockProvider implements BrokerProvider {
  readonly name = "mock";

  async getAccount(): Promise<AccountInfo> {
    return {
      equity: 28_990.0,
      cash: 5_000.0,
      buyingPower: 10_000.0,
      portfolioValue: 28_990.0,
      dayPL: 320.5,
      dayPLPercent: 1.12,
    };
  }

  async getPositions(): Promise<Position[]> {
    return MOCK_POSITIONS;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const upper = symbol.toUpperCase();
    const quote = MOCK_QUOTES[upper];
    if (quote) {
      return quote;
    }
    // Generate a random-ish quote for unknown symbols
    const price = 100 + Math.random() * 200;
    const change = (Math.random() - 0.5) * 10;
    return {
      symbol: upper,
      lastPrice: Math.round(price * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round((change / price) * 10000) / 100,
      volume: Math.floor(Math.random() * 50_000_000),
    };
  }
}
