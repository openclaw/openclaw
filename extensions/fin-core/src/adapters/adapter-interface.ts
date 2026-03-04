/**
 * Unified exchange adapter interface for multi-market real trading.
 * Each adapter wraps a specific broker/exchange API (CCXT, Alpaca, Futu)
 * behind a consistent interface for order execution, balance queries,
 * and health monitoring.
 */
import type { Balance, MarketType, OrderResult, Position, TickerData } from "../types.js";

/** Parameters for placing an order through an adapter. */
export interface AdapterOrderParams {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  price?: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  reduceOnly?: boolean;
  timeInForce?: "day" | "gtc" | "ioc";
}

/** Unified exchange adapter. All market-specific logic is hidden behind this interface. */
export interface UnifiedExchangeAdapter {
  readonly exchangeId: string;
  readonly marketType: MarketType;
  readonly isTestnet: boolean;

  /** Place a new order. */
  placeOrder(params: AdapterOrderParams): Promise<OrderResult>;

  /** Cancel an existing order. */
  cancelOrder(orderId: string, symbol: string): Promise<void>;

  /** Fetch account balances. */
  fetchBalance(): Promise<Balance[]>;

  /** Fetch open positions. */
  fetchPositions(symbol?: string): Promise<Position[]>;

  /** Fetch current ticker for a symbol. */
  fetchTicker(symbol: string): Promise<TickerData>;

  /** Fetch open orders. */
  fetchOpenOrders(symbol?: string): Promise<OrderResult[]>;

  /** Check if the connection is healthy. */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}
