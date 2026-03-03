/**
 * Alpaca Paper Trading API adapter.
 *
 * Uses only native fetch — no additional dependencies.
 * Supports both paper and live environments via baseUrl toggle.
 *
 * Alpaca docs: https://docs.alpaca.markets/reference
 */
import type {
  MarketAdapter,
  PriceQuote,
  AdapterOrderRequest,
  AdapterOrderResult,
  AdapterAccountState,
  AdapterPosition,
} from "./types.js";

const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

export class AlpacaAdapter implements MarketAdapter {
  readonly id = "alpaca";
  readonly name = "Alpaca Markets";
  readonly market = "us-equity" as const;

  private baseUrl = PAPER_BASE;
  private dataUrl = DATA_BASE;
  private headers: Record<string, string> = {};
  private initialized = false;

  async init(config: Record<string, unknown>): Promise<void> {
    const apiKeyId = String(config.apiKeyId ?? "");
    const apiSecretKey = String(config.apiSecretKey ?? "");

    if (!apiKeyId || !apiSecretKey) {
      throw new Error("AlpacaAdapter: apiKeyId and apiSecretKey are required");
    }

    this.baseUrl = config.live === true ? LIVE_BASE : PAPER_BASE;
    this.dataUrl = typeof config.dataUrl === "string" ? config.dataUrl : DATA_BASE;

    this.headers = {
      "APCA-API-KEY-ID": apiKeyId,
      "APCA-API-SECRET-KEY": apiSecretKey,
      "Content-Type": "application/json",
    };

    this.initialized = true;
  }

  async getPrice(symbol: string): Promise<PriceQuote> {
    this.ensureInit();
    const url = `${this.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`;
    const res = await fetch(url, { headers: this.headers });

    if (!res.ok) {
      throw new Error(`Alpaca getPrice(${symbol}) failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      quote: { ap: number; bp: number; t: string };
    };

    const quote = data.quote;
    // Midpoint as "last" since the quotes endpoint returns bid/ask, not last trade.
    const bid = quote.bp ?? 0;
    const ask = quote.ap ?? 0;
    const last = bid && ask ? (bid + ask) / 2 : bid || ask;

    return {
      last,
      bid: bid || undefined,
      ask: ask || undefined,
      timestamp: new Date(quote.t).getTime(),
    };
  }

  async submitOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult> {
    this.ensureInit();
    const body = {
      symbol: order.symbol,
      qty: String(order.qty),
      side: order.side,
      type: order.type,
      time_in_force: order.timeInForce ?? "day",
      ...(order.type === "limit" && order.limitPrice != null
        ? { limit_price: String(order.limitPrice) }
        : {}),
    };

    const res = await fetch(`${this.baseUrl}/v2/orders`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        orderId: "",
        status: "rejected",
        filledQty: 0,
        filledPrice: 0,
        message: `Alpaca order rejected: ${res.status} ${errText}`,
      };
    }

    const data = (await res.json()) as {
      id: string;
      status: string;
      filled_qty: string;
      filled_avg_price: string | null;
    };

    return {
      orderId: data.id,
      status: mapAlpacaStatus(data.status),
      filledQty: Number(data.filled_qty) || 0,
      filledPrice: Number(data.filled_avg_price) || 0,
    };
  }

  async getAccountState(): Promise<AdapterAccountState> {
    this.ensureInit();

    // Fetch account and positions in parallel.
    const [accountRes, positionsRes] = await Promise.all([
      fetch(`${this.baseUrl}/v2/account`, { headers: this.headers }),
      fetch(`${this.baseUrl}/v2/positions`, { headers: this.headers }),
    ]);

    if (!accountRes.ok) {
      throw new Error(`Alpaca getAccountState failed: ${accountRes.status} ${await accountRes.text()}`);
    }

    const account = (await accountRes.json()) as {
      equity: string;
      cash: string;
      buying_power: string;
    };

    const positions: AdapterPosition[] = [];
    if (positionsRes.ok) {
      const rawPositions = (await positionsRes.json()) as Array<{
        symbol: string;
        qty: string;
        avg_entry_price: string;
        current_price: string;
        unrealized_pl: string;
      }>;

      for (const p of rawPositions) {
        positions.push({
          symbol: p.symbol,
          qty: Number(p.qty),
          avgPrice: Number(p.avg_entry_price),
          currentPrice: Number(p.current_price),
          unrealizedPnl: Number(p.unrealized_pl),
        });
      }
    }

    return {
      equity: Number(account.equity),
      cash: Number(account.cash),
      buyingPower: Number(account.buying_power),
      positions,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.ensureInit();
      await this.getAccountState();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    // Alpaca REST API is stateless; nothing to tear down.
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error("AlpacaAdapter: not initialized — call init() first");
    }
  }
}

/** Map Alpaca order status string to our unified status enum. */
function mapAlpacaStatus(status: string): AdapterOrderResult["status"] {
  switch (status) {
    case "filled":
      return "filled";
    case "partially_filled":
      return "partial";
    case "new":
    case "accepted":
    case "pending_new":
    case "accepted_for_bidding":
      return "accepted";
    default:
      return "rejected";
  }
}
