export interface PaperOrder {
  id: string;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  status: "pending" | "filled" | "cancelled" | "rejected";
  fillPrice?: number;
  commission?: number;
  slippage?: number;
  createdAt: number;
  filledAt?: number;
  reason?: string;
  strategyId?: string;
  /** Extended market type for the order. */
  market?: string;
}

export interface PaperPosition {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: number;
  /** Settlement lots for T+N tracking. Undefined = all freely sellable. */
  lots?: PositionLot[];
}

export interface PaperAccountState {
  id: string;
  name: string;
  initialCapital: number;
  cash: number;
  equity: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  createdAt: number;
  updatedAt: number;
}

// Canonical definition lives in @openfinclaw/fin-shared-types.
// Re-exported here for backward compatibility within fin-paper-trading.
export type { DecayState } from "../shared/types.js";

export interface PositionLot {
  quantity: number;
  entryPrice: number;
  /** Timestamp after which this lot can be sold (used for T+1 settlement). */
  settlableAfter: number;
}

export interface EquitySnapshot {
  accountId: string;
  timestamp: number;
  equity: number;
  cash: number;
  positionsValue: number;
  dailyPnl: number;
  dailyPnlPct: number;
}
