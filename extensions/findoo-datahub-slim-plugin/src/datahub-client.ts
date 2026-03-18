import type { OHLCV, Ticker } from "./types.js";

/**
 * Slim DataHub REST client via Gateway proxy.
 * Uses Bearer token authentication (fch_<64-char-hex>).
 * Gateway validates API key in Redis, then forwards to DataHub with Basic Auth.
 */
export class DataHubClient {
  private authHeader: string;

  constructor(
    private gatewayUrl: string,
    apiKey: string,
    private timeoutMs: number,
  ) {
    this.authHeader = `Bearer ${apiKey}`;
  }

  async query(path: string, params?: Record<string, string>): Promise<unknown[]> {
    const url = new URL(`${this.gatewayUrl}/api/v1/${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    const resp = await fetch(url.toString(), {
      headers: { Authorization: this.authHeader },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (resp.status === 204) return [];
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Gateway error (${resp.status}): ${text.slice(0, 300)}`);

    let payload: { results?: unknown[]; detail?: string };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Gateway returned non-JSON (${resp.status}): ${text.slice(0, 200)}`);
    }
    if (payload.detail) throw new Error(`Gateway: ${payload.detail}`);
    return payload.results ?? [];
  }

  // --- Category shortcuts ---

  crypto(endpoint: string, params?: Record<string, string>) {
    return this.query(`crypto/${endpoint}`, params);
  }

  equity(endpoint: string, params?: Record<string, string>) {
    return this.query(`equity/${endpoint}`, params);
  }

  // --- Typed convenience ---

  async getOHLCV(params: {
    symbol: string;
    market: string;
    since?: number;
    limit?: number;
  }): Promise<OHLCV[]> {
    const qp: Record<string, string> = { symbol: params.symbol };
    if (params.since) qp.start_date = new Date(params.since).toISOString().slice(0, 10);
    // Always pass limit to API to avoid fetching full history
    const apiLimit = params.limit ? String(Math.min(params.limit * 2, 500)) : "100";
    qp.limit = apiLimit;

    const results =
      params.market === "crypto"
        ? await this.crypto("price/historical", { ...qp, provider: "ccxt" })
        : await this.equity("price/historical", { ...qp, provider: detectProvider(params.symbol) });

    return this.normalizeOHLCV(results, params.limit);
  }

  async getTicker(symbol: string, market: string): Promise<Ticker> {
    if (market === "crypto") {
      const results = await this.crypto("market/ticker", { symbol, exchange: "binance" });
      const t = (results[0] ?? {}) as Record<string, unknown>;
      return {
        symbol,
        market: "crypto",
        last: Number(t.last ?? t.close ?? t.bid ?? 0),
        volume24h: Number(t.baseVolume ?? t.volume ?? 0) || undefined,
        timestamp: Date.now(),
      };
    }

    // Equity — latest bar as ticker
    const qp: Record<string, string> = {
      symbol,
      provider: detectProvider(symbol),
      limit: "5",
    };
    const results = await this.equity("price/historical", qp);
    // API may return in descending order — pick the row with the most recent date
    const rows = (results as Array<Record<string, unknown>>).sort((a, b) => {
      const da = String(a.date ?? a.trade_date ?? "");
      const db = String(b.date ?? b.trade_date ?? "");
      return db.localeCompare(da);
    });
    const last = rows[0] as Record<string, unknown> | undefined;
    if (!last) throw new Error(`No ticker data for ${symbol}`);
    return {
      symbol,
      market: "equity",
      last: Number(last.close ?? 0),
      volume24h: Number(last.volume ?? 0) || undefined,
      timestamp: last.date ? new Date(String(last.date)).getTime() : Date.now(),
    };
  }

  private normalizeOHLCV(results: unknown[], limit?: number): OHLCV[] {
    const rows = (results as Array<Record<string, unknown>>)
      .map((r) => {
        const ts = r.date ?? r.trade_date ?? r.timestamp;
        if (!ts) return null;
        return {
          timestamp: typeof ts === "number" ? ts : new Date(String(ts)).getTime(),
          open: Number(r.open) || 0,
          high: Number(r.high) || 0,
          low: Number(r.low) || 0,
          close: Number(r.close) || 0,
          volume: Number(r.volume ?? r.vol) || 0,
        };
      })
      .filter((r): r is OHLCV => r !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
    return limit ? rows.slice(-limit) : rows;
  }
}

function detectProvider(symbol: string): string {
  const u = symbol.toUpperCase();
  if (
    u.endsWith(".SH") ||
    u.endsWith(".SZ") ||
    u.endsWith(".BJ") ||
    u.endsWith(".HK") ||
    /^\d{6}/.test(u)
  )
    return "tushare";
  return "massive";
}
