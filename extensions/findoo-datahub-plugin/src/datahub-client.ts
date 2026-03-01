import type { OHLCV, Ticker } from "./types.js";

/**
 * DataHub REST API client.
 * Connects to the xDAN-Finance-Data-openbb server at 43.134.61.136:8088.
 * Auth: Basic admin:<apiKey>
 * Response shape: { results: [...], provider: "...", warnings: null }
 */
export class DataHubClient {
  private authHeader: string;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private timeoutMs: number,
  ) {
    // Basic Auth: admin:<apiKey>
    this.authHeader = `Basic ${btoa(`admin:${apiKey}`)}`;
  }

  /** Generic query against any DataHub REST endpoint. */
  async query(
    category: string,
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<unknown[]> {
    const url = new URL(`${this.baseUrl}/api/v1/${category}/${endpoint}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const resp = await fetch(url.toString(), {
      headers: { Authorization: this.authHeader },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`DataHub error (${resp.status}): ${text.slice(0, 300)}`);
    }

    let payload: { results?: unknown[]; error?: string };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`DataHub returned non-JSON (${resp.status}): ${text.slice(0, 200)}`);
    }

    return payload.results ?? [];
  }

  /** Fetch OHLCV via DataHub REST. Routes by market. */
  async getOHLCV(params: {
    symbol: string;
    market: string;
    timeframe: string;
    since?: number;
    limit?: number;
  }): Promise<OHLCV[]> {
    const { symbol, market, timeframe } = params;

    // Route to appropriate DataHub endpoint by market type
    const queryParams: Record<string, string> = { symbol };

    if (market === "crypto") {
      // Crypto: /api/v1/crypto/price/historical
      if (params.since) {
        queryParams.start_date = new Date(params.since).toISOString().slice(0, 10);
      }
      queryParams.provider = "ccxt";
      const results = await this.query("crypto/price", "historical", queryParams);
      return this.normalizeOHLCV(results, params.limit);
    }

    // Equity: /api/v1/equity/stock/historical
    // Detect provider by market
    if (market === "equity") {
      const upper = symbol.toUpperCase();
      if (
        upper.endsWith(".SH") ||
        upper.endsWith(".SZ") ||
        upper.endsWith(".BJ") ||
        /^\d{6}/.test(upper)
      ) {
        queryParams.provider = "tushare";
      } else if (upper.endsWith(".HK")) {
        queryParams.provider = "tushare";
      } else {
        queryParams.provider = "polygon";
      }

      if (params.since) {
        queryParams.start_date = new Date(params.since).toISOString().slice(0, 10);
      }

      const results = await this.query("equity/stock", "historical", queryParams);
      return this.normalizeOHLCV(results, params.limit);
    }

    throw new Error(`DataHub: unsupported market "${market}"`);
  }

  /** Fetch ticker via DataHub REST. */
  async getTicker(symbol: string, market: string): Promise<Ticker> {
    const queryParams: Record<string, string> = { symbol };

    if (market === "crypto") {
      queryParams.provider = "ccxt";
      const results = await this.query("crypto/price", "historical", queryParams);
      const last = results[results.length - 1] as Record<string, unknown> | undefined;
      return {
        symbol,
        market: "crypto",
        last: Number(last?.close ?? 0),
        timestamp: last?.date ? new Date(String(last.date)).getTime() : Date.now(),
      };
    }

    // Equity ticker — fetch latest daily bar
    const upper = symbol.toUpperCase();
    if (
      upper.endsWith(".SH") ||
      upper.endsWith(".SZ") ||
      upper.endsWith(".BJ") ||
      /^\d{6}/.test(upper)
    ) {
      queryParams.provider = "tushare";
    } else if (upper.endsWith(".HK")) {
      queryParams.provider = "tushare";
    } else {
      queryParams.provider = "polygon";
    }
    queryParams.limit = "1";

    const results = await this.query("equity/stock", "historical", queryParams);
    const last = results[results.length - 1] as Record<string, unknown> | undefined;
    if (!last) throw new Error(`No ticker data for ${symbol}`);

    return {
      symbol,
      market: "equity",
      last: Number(last.close ?? 0),
      volume24h: Number(last.volume ?? 0) || undefined,
      timestamp: last.date ? new Date(String(last.date)).getTime() : Date.now(),
    };
  }

  /** Normalize DataHub response rows to canonical OHLCV format. */
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
