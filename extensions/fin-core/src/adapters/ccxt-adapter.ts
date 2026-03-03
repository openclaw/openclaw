/**
 * CCXT adapter — wraps a CCXT exchange instance from ExchangeRegistry
 * into the UnifiedExchangeAdapter interface.
 */
import type { ExchangeRegistry } from "../exchange-registry.js";
import type { Balance, OrderResult, Position, TickerData } from "../types.js";
import type { AdapterOrderParams, UnifiedExchangeAdapter } from "./adapter-interface.js";

/** Minimal CCXT exchange shape to avoid importing ccxt types at compile time. */
interface CcxtExchange {
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  cancelOrder(id: string, symbol: string): Promise<Record<string, unknown>>;
  fetchBalance(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  fetchPositions(symbols?: string[], params?: Record<string, unknown>): Promise<unknown[]>;
  fetchTicker(symbol: string): Promise<Record<string, unknown>>;
  fetchOpenOrders(symbol?: string): Promise<unknown[]>;
}

export class CcxtAdapter implements UnifiedExchangeAdapter {
  readonly marketType = "crypto" as const;

  constructor(
    readonly exchangeId: string,
    readonly isTestnet: boolean,
    private registry: ExchangeRegistry,
  ) {}

  private async ccxt(): Promise<CcxtExchange> {
    return (await this.registry.getInstance(this.exchangeId)) as CcxtExchange;
  }

  async placeOrder(params: AdapterOrderParams): Promise<OrderResult> {
    const exchange = await this.ccxt();
    const ccxtParams: Record<string, unknown> = {};
    if (params.stopLoss) ccxtParams.stopLoss = { triggerPrice: params.stopLoss };
    if (params.takeProfit) ccxtParams.takeProfit = { triggerPrice: params.takeProfit };
    if (params.reduceOnly) ccxtParams.reduceOnly = true;
    if (params.leverage) ccxtParams.leverage = params.leverage;

    const raw = await exchange.createOrder(
      params.symbol,
      params.type,
      params.side,
      params.amount,
      params.price,
      ccxtParams,
    );

    return {
      orderId: String(raw.id ?? ""),
      exchangeId: this.exchangeId,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      amount: params.amount,
      filledAmount: Number(raw.filled ?? 0),
      price: params.price ?? Number(raw.price ?? 0),
      avgFillPrice: raw.average ? Number(raw.average) : undefined,
      status: mapCcxtStatus(String(raw.status ?? "open")),
      timestamp: Number(raw.timestamp ?? Date.now()),
      fee: raw.fee
        ? { cost: Number((raw.fee as Record<string, unknown>).cost ?? 0), currency: String((raw.fee as Record<string, unknown>).currency ?? "USDT") }
        : undefined,
    };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    const exchange = await this.ccxt();
    await exchange.cancelOrder(orderId, symbol);
  }

  async fetchBalance(): Promise<Balance[]> {
    const exchange = await this.ccxt();
    const raw = await exchange.fetchBalance();
    const balances: Balance[] = [];
    const total = (raw.total ?? {}) as Record<string, number>;
    const free = (raw.free ?? {}) as Record<string, number>;
    const used = (raw.used ?? {}) as Record<string, number>;

    for (const [currency, totalAmt] of Object.entries(total)) {
      if (totalAmt > 0) {
        balances.push({
          exchange: this.exchangeId as Balance["exchange"],
          currency,
          total: totalAmt,
          free: free[currency] ?? 0,
          used: used[currency] ?? 0,
        });
      }
    }
    return balances;
  }

  async fetchPositions(symbol?: string): Promise<Position[]> {
    const exchange = await this.ccxt();
    const raw = await exchange.fetchPositions(symbol ? [symbol] : undefined);
    return (raw as Record<string, unknown>[])
      .filter((p) => Number(p.contracts ?? 0) > 0)
      .map((p) => ({
        exchange: this.exchangeId as Position["exchange"],
        symbol: String(p.symbol ?? ""),
        side: (String(p.side ?? "long") === "short" ? "short" : "long") as "long" | "short",
        size: Number(p.contracts ?? 0),
        entryPrice: Number(p.entryPrice ?? 0),
        currentPrice: Number(p.markPrice ?? p.lastPrice ?? 0),
        unrealizedPnl: Number(p.unrealizedPnl ?? 0),
        leverage: Number(p.leverage ?? 1),
        liquidationPrice: p.liquidationPrice ? Number(p.liquidationPrice) : undefined,
        marginRatio: p.marginRatio ? Number(p.marginRatio) : undefined,
      }));
  }

  async fetchTicker(symbol: string): Promise<TickerData> {
    const exchange = await this.ccxt();
    const raw = await exchange.fetchTicker(symbol);
    return {
      symbol,
      last: Number(raw.last ?? 0),
      bid: raw.bid ? Number(raw.bid) : undefined,
      ask: raw.ask ? Number(raw.ask) : undefined,
      volume24h: raw.quoteVolume ? Number(raw.quoteVolume) : undefined,
      change24hPct: raw.percentage ? Number(raw.percentage) : undefined,
      timestamp: Number(raw.timestamp ?? Date.now()),
    };
  }

  async fetchOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const exchange = await this.ccxt();
    const raw = (await exchange.fetchOpenOrders(symbol)) as Record<string, unknown>[];
    return raw.map((o) => ({
      orderId: String(o.id ?? ""),
      exchangeId: this.exchangeId,
      symbol: String(o.symbol ?? ""),
      side: String(o.side ?? "buy") as "buy" | "sell",
      type: String(o.type ?? "limit") as "market" | "limit",
      amount: Number(o.amount ?? 0),
      filledAmount: Number(o.filled ?? 0),
      price: Number(o.price ?? 0),
      status: mapCcxtStatus(String(o.status ?? "open")),
      timestamp: Number(o.timestamp ?? Date.now()),
    }));
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const exchange = await this.ccxt();
      await exchange.fetchTicker("BTC/USDT");
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function mapCcxtStatus(status: string): OrderResult["status"] {
  switch (status) {
    case "closed":
      return "closed";
    case "canceled":
    case "cancelled":
    case "expired":
      return "canceled";
    case "rejected":
      return "rejected";
    default:
      return "open";
  }
}
