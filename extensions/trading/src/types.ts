// =============================================================================
// Trading Data Types
// =============================================================================

export type Position = {
  symbol: string;
  qty: number;
  marketValue: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
};

export type AccountInfo = {
  equity: number;
  cash: number;
  buyingPower: number;
  portfolioValue: number;
  dayPL: number;
  dayPLPercent: number;
};

export type Quote = {
  symbol: string;
  lastPrice: number;
  change: number;
  changePercent: number;
  volume: number;
};

// =============================================================================
// Broker Provider Interface
// =============================================================================

export interface BrokerProvider {
  readonly name: string;
  getAccount(): Promise<AccountInfo>;
  getPositions(): Promise<Position[]>;
  getQuote(symbol: string): Promise<Quote>;
}
