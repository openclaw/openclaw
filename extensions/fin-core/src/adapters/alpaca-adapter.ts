/**
 * Alpaca adapter — wraps Alpaca REST API into the UnifiedExchangeAdapter interface.
 * Supports both paper and live environments.
 * Uses only native fetch — no external dependencies.
 *
 * Alpaca docs: https://docs.alpaca.markets/reference
 */
import type { Balance, OrderResult, Position, TickerData } from "../types.js";
import type { AdapterOrderParams, UnifiedExchangeAdapter } from "./adapter-interface.js";

const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

export class AlpacaAdapter implements UnifiedExchangeAdapter {
  readonly marketType = "us-equity" as const;

  private baseUrl: string;
  private dataUrl: string;
  private headers: Record<string, string>;

  constructor(
    readonly exchangeId: string,
    readonly isTestnet: boolean,
    apiKeyId: string,
    apiSecretKey: string,
  ) {
    this.baseUrl = isTestnet ? PAPER_BASE : LIVE_BASE;
    this.dataUrl = DATA_BASE;
    this.headers = {
      "APCA-API-KEY-ID": apiKeyId,
      "APCA-API-SECRET-KEY": apiSecretKey,
      "Content-Type": "application/json",
    };
  }

  async placeOrder(params: AdapterOrderParams): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      symbol: params.symbol,
      qty: String(params.amount),
      side: params.side,
      type: params.type,
      time_in_force: params.timeInForce ?? "day",
    };

    if (params.type === "limit" && params.price != null) {
      body.limit_price = String(params.price);
    }
    if (params.stopLoss != null) {
      body.stop_loss = { stop_price: String(params.stopLoss) };
    }
    if (params.takeProfit != null) {
      body.take_profit = { limit_price: String(params.takeProfit) };
    }

    const res = await fetch(`${this.baseUrl}/v2/orders`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Alpaca order failed: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as AlpacaOrderResponse;
    return mapAlpacaOrder(data, this.exchangeId, params);
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v2/orders/${orderId}`, {
      method: "DELETE",
      headers: this.headers,
    });

    if (!res.ok && res.status !== 204) {
      throw new Error(`Alpaca cancel failed: ${res.status} ${await res.text()}`);
    }
  }

  async fetchBalance(): Promise<Balance[]> {
    const res = await fetch(`${this.baseUrl}/v2/account`, { headers: this.headers });
    if (!res.ok) throw new Error(`Alpaca account fetch failed: ${res.status}`);

    const data = (await res.json()) as AlpacaAccount;
    return [
      {
        exchange: this.exchangeId as Balance["exchange"],
        currency: "USD",
        total: Number(data.equity),
        free: Number(data.cash),
        used: Number(data.equity) - Number(data.cash),
      },
    ];
  }

  async fetchPositions(symbol?: string): Promise<Position[]> {
    const url = symbol
      ? `${this.baseUrl}/v2/positions/${encodeURIComponent(symbol)}`
      : `${this.baseUrl}/v2/positions`;
    const res = await fetch(url, { headers: this.headers });

    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error(`Alpaca positions fetch failed: ${res.status}`);
    }

    const raw = (await res.json()) as AlpacaPosition | AlpacaPosition[];
    const positions = Array.isArray(raw) ? raw : [raw];

    return positions.map((p) => ({
      exchange: this.exchangeId as Position["exchange"],
      symbol: p.symbol,
      side: Number(p.qty) >= 0 ? ("long" as const) : ("short" as const),
      size: Math.abs(Number(p.qty)),
      entryPrice: Number(p.avg_entry_price),
      currentPrice: Number(p.current_price),
      unrealizedPnl: Number(p.unrealized_pl),
      leverage: 1,
    }));
  }

  async fetchTicker(symbol: string): Promise<TickerData> {
    const url = `${this.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`;
    const res = await fetch(url, { headers: this.headers });

    if (!res.ok) throw new Error(`Alpaca ticker fetch failed: ${res.status}`);

    const data = (await res.json()) as { quote: { ap: number; bp: number; t: string } };
    const bid = data.quote.bp ?? 0;
    const ask = data.quote.ap ?? 0;
    const last = bid && ask ? (bid + ask) / 2 : bid || ask;

    return {
      symbol,
      last,
      bid: bid || undefined,
      ask: ask || undefined,
      timestamp: new Date(data.quote.t).getTime(),
    };
  }

  async fetchOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const url = new URL(`${this.baseUrl}/v2/orders`);
    url.searchParams.set("status", "open");
    if (symbol) url.searchParams.set("symbols", symbol);

    const res = await fetch(url.toString(), { headers: this.headers });
    if (!res.ok) throw new Error(`Alpaca open orders fetch failed: ${res.status}`);

    const data = (await res.json()) as AlpacaOrderResponse[];
    return data.map((o) => mapAlpacaOrder(o, this.exchangeId));
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/v2/account`, { headers: this.headers });
      return { ok: res.ok, latencyMs: Date.now() - start, error: res.ok ? undefined : `status ${res.status}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── Alpaca API types ──

interface AlpacaOrderResponse {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  limit_price: string | null;
  status: string;
  created_at: string;
}

interface AlpacaAccount {
  equity: string;
  cash: string;
  buying_power: string;
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
}

// ── Helpers ──

function mapAlpacaOrder(
  o: AlpacaOrderResponse,
  exchangeId: string,
  params?: AdapterOrderParams,
): OrderResult {
  return {
    orderId: o.id,
    exchangeId,
    symbol: o.symbol ?? params?.symbol ?? "",
    side: (o.side ?? params?.side ?? "buy") as "buy" | "sell",
    type: (o.type ?? params?.type ?? "market") as "market" | "limit",
    amount: Number(o.qty) || params?.amount || 0,
    filledAmount: Number(o.filled_qty) || 0,
    price: Number(o.limit_price ?? o.filled_avg_price ?? params?.price ?? 0),
    avgFillPrice: o.filled_avg_price ? Number(o.filled_avg_price) : undefined,
    status: mapAlpacaStatus(o.status),
    timestamp: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
  };
}

function mapAlpacaStatus(status: string): OrderResult["status"] {
  switch (status) {
    case "filled":
      return "closed";
    case "partially_filled":
    case "new":
    case "accepted":
    case "pending_new":
    case "accepted_for_bidding":
      return "open";
    case "canceled":
    case "expired":
    case "pending_cancel":
      return "canceled";
    default:
      return "rejected";
  }
}
