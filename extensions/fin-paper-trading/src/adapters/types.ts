/**
 * Unified market adapter interface for multi-market paper trading.
 * Each adapter bridges a specific broker/exchange API to provide
 * a consistent interface for price queries, order submission, and
 * account state retrieval.
 */
export interface MarketAdapter {
  readonly id: string;
  readonly name: string;
  readonly market: "us-equity" | "hk-equity" | "cn-a-share";

  init(config: Record<string, unknown>): Promise<void>;
  getPrice(symbol: string): Promise<PriceQuote>;
  submitOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult>;
  getAccountState(): Promise<AdapterAccountState>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
  close(): Promise<void>;
}

export interface PriceQuote {
  last: number;
  bid?: number;
  ask?: number;
  timestamp: number;
}

export interface AdapterOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit";
  limitPrice?: number;
  timeInForce?: "day" | "gtc" | "ioc";
}

export interface AdapterOrderResult {
  orderId: string;
  status: "accepted" | "rejected" | "filled" | "partial";
  filledQty: number;
  filledPrice: number;
  message?: string;
}

export interface AdapterAccountState {
  equity: number;
  cash: number;
  buyingPower: number;
  positions: AdapterPosition[];
}

export interface AdapterPosition {
  symbol: string;
  qty: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
}
