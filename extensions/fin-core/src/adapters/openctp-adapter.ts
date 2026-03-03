/**
 * OpenCTP adapter — wraps a CTP HTTP REST bridge into the UnifiedExchangeAdapter interface.
 * Supports SimNow (simnow.com.cn) paper trading and openctp.net multi-market simulation.
 *
 * The CTP protocol is TCP/protobuf-based. This adapter talks to a lightweight HTTP REST
 * bridge (similar to Futu's pattern) running alongside the CTP gateway.
 *
 * Key A-share rules enforced:
 * - T+1: cannot sell shares bought today (enforced server-side by CTP)
 * - Lot size: buy must be multiple of 100 (enforced by market-rules)
 * - Trading hours: 9:30-11:30, 13:00-15:00 CST
 * - Price limits: ±10% from previous close (enforced server-side)
 */
import type { Balance, OrderResult, Position, TickerData } from "../types.js";
import type { AdapterOrderParams, UnifiedExchangeAdapter } from "./adapter-interface.js";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:7090";

export class OpenCtpAdapter implements UnifiedExchangeAdapter {
  readonly marketType = "cn-a-share" as const;
  readonly isTestnet: boolean;

  private bridgeUrl: string;
  private ctpFrontAddr: string;
  private ctpBrokerId: string;
  private ctpAppId: string;
  private ctpAuthCode: string;

  constructor(
    readonly exchangeId: string,
    isTestnet: boolean,
    ctpFrontAddr: string,
    ctpBrokerId: string,
    ctpAppId?: string,
    ctpAuthCode?: string,
    bridgeUrl?: string,
  ) {
    this.isTestnet = isTestnet;
    this.ctpFrontAddr = ctpFrontAddr;
    this.ctpBrokerId = ctpBrokerId;
    this.ctpAppId = ctpAppId ?? "";
    this.ctpAuthCode = ctpAuthCode ?? "";
    this.bridgeUrl = bridgeUrl ?? DEFAULT_BRIDGE_URL;
  }

  async placeOrder(params: AdapterOrderParams): Promise<OrderResult> {
    const data = await this.request<CtpOrderResponse>("POST", "/order", {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      qty: params.amount,
      limitPrice: params.price,
      timeInForce: params.timeInForce ?? "day",
    });

    return {
      orderId: data.orderId ?? "",
      exchangeId: this.exchangeId,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      amount: params.amount,
      filledAmount: data.filledQty ?? 0,
      price: params.price ?? data.filledPrice ?? 0,
      avgFillPrice: data.filledPrice || undefined,
      status: mapCtpStatus(data.status ?? ""),
      timestamp: data.timestamp ?? Date.now(),
    };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    await this.request("DELETE", `/order/${orderId}`, { symbol });
  }

  async fetchBalance(): Promise<Balance[]> {
    const data = await this.request<CtpAccount>("GET", "/account");
    return [
      {
        exchange: this.exchangeId as Balance["exchange"],
        currency: "CNY",
        total: data.balance ?? 0,
        free: data.available ?? 0,
        used: (data.balance ?? 0) - (data.available ?? 0),
      },
    ];
  }

  async fetchPositions(symbol?: string): Promise<Position[]> {
    const path = symbol ? `/positions?symbol=${encodeURIComponent(symbol)}` : "/positions";
    const data = await this.request<CtpPosition[]>("GET", path);

    return (data ?? []).map((p) => ({
      exchange: this.exchangeId as Position["exchange"],
      symbol: p.symbol,
      side: (p.side === "short" ? "short" : "long") as "long" | "short",
      size: Math.abs(p.qty),
      entryPrice: p.avgPrice,
      currentPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnl ?? 0,
      leverage: 1,
    }));
  }

  async fetchTicker(symbol: string): Promise<TickerData> {
    const data = await this.request<CtpQuote>("GET", `/quote/${encodeURIComponent(symbol)}`);
    return {
      symbol,
      last: data.last ?? 0,
      bid: data.bid || undefined,
      ask: data.ask || undefined,
      volume24h: data.volume || undefined,
      timestamp: data.timestamp ?? Date.now(),
    };
  }

  async fetchOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const path = symbol
      ? `/orders?status=open&symbol=${encodeURIComponent(symbol)}`
      : "/orders?status=open";
    const data = await this.request<CtpOrderResponse[]>("GET", path);

    return (data ?? []).map((o) => ({
      orderId: o.orderId ?? "",
      exchangeId: this.exchangeId,
      symbol: o.symbol ?? "",
      side: (o.side ?? "buy") as "buy" | "sell",
      type: (o.type ?? "limit") as "market" | "limit",
      amount: o.qty ?? 0,
      filledAmount: o.filledQty ?? 0,
      price: o.price ?? 0,
      status: mapCtpStatus(o.status ?? ""),
      timestamp: o.timestamp ?? Date.now(),
    }));
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.bridgeUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return {
        ok: res.ok,
        latencyMs: Date.now() - start,
        error: res.ok ? undefined : `status ${res.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── internal ──

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.bridgeUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`OpenCtpAdapter ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }

    return (await res.json()) as T;
  }
}

// ── CTP bridge API types ──

interface CtpOrderResponse {
  orderId?: string;
  symbol?: string;
  side?: string;
  type?: string;
  qty?: number;
  filledQty?: number;
  filledPrice?: number;
  price?: number;
  status?: string;
  timestamp?: number;
}

interface CtpAccount {
  balance?: number;
  available?: number;
  frozenMargin?: number;
  frozenCommission?: number;
}

interface CtpPosition {
  symbol: string;
  side: string;
  qty: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl?: number;
  todayBuyQty?: number;
  todaySellQty?: number;
}

interface CtpQuote {
  last?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  timestamp?: number;
}

// ── Helpers ──

function mapCtpStatus(status: string): OrderResult["status"] {
  switch (status) {
    case "filled":
    case "全部成交":
      return "closed";
    case "cancelled":
    case "已撤单":
      return "canceled";
    case "rejected":
    case "已废单":
      return "rejected";
    default:
      return "open";
  }
}
