import type { OHLCV, Ticker } from "./types.js";

/**
 * DataHub REST API client.
 * Single upstream for all financial data — routes internally to
 * Tushare/yfinance/Polygon/CCXT/CoinGecko/DefiLlama/WorldBank.
 *
 * Auth: Basic admin:<apiKey>
 * Response: { results: [...], provider: "...", warnings: null }
 */
export class DataHubClient {
  private authHeader: string;

  constructor(
    private baseUrl: string,
    username: string,
    password: string,
    private timeoutMs: number,
  ) {
    this.authHeader = `Basic ${btoa(`${username}:${password}`)}`;
  }

  /* ============================================================
   * Generic query — all category helpers delegate here
   * ============================================================ */

  async query(path: string, params?: Record<string, string>): Promise<unknown[]> {
    const url = new URL(`${this.baseUrl}/api/v1/${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const resp = await fetch(url.toString(), {
      headers: { Authorization: this.authHeader },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (resp.status === 204) return [];

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`DataHub error (${resp.status}): ${text.slice(0, 300)}`);
    }

    let payload: { results?: unknown[]; error?: string; detail?: string };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`DataHub returned non-JSON (${resp.status}): ${text.slice(0, 200)}`);
    }

    if (payload.detail) {
      throw new Error(`DataHub: ${payload.detail}`);
    }

    return payload.results ?? [];
  }

  /* ============================================================
   * 8 category helpers — thin wrappers over query()
   * ============================================================ */

  /** /api/v1/equity/* — A-share, HK, US equity data (83 endpoints) */
  equity(endpoint: string, params?: Record<string, string>): Promise<unknown[]> {
    return this.query(`equity/${endpoint}`, params);
  }

  /** /api/v1/crypto/* — CEX market data + DeFi + CoinGecko (23 endpoints) */
  crypto(endpoint: string, params?: Record<string, string>): Promise<unknown[]> {
    return this.query(`crypto/${endpoint}`, params);
  }

  /** /api/v1/economy/* — Macro, rates, FX, WorldBank (21 endpoints) */
  economy(endpoint: string, params?: Record<string, string>): Promise<unknown[]> {
    return this.query(`economy/${endpoint}`, params);
  }

  /** /api/v1/derivatives/* — Futures, options, convertible bonds (13 endpoints) */
  derivatives(endpoint: string, params?: Record<string, string>): Promise<unknown[]> {
    return this.query(`derivatives/${endpoint}`, params);
  }

  /** /api/v1/index/* — Index data, thematic indices (12 endpoints) */
  index(endpoint: string, params?: Record<string, string>): Promise<unknown[]> {
    return this.query(`index/${endpoint}`, params);
  }

  /** /api/v1/etf/* — ETF + Fund data (9 endpoints) */
  etf(endpoint: string, params?: Record<string, string>): Promise<unknown[]> {
    return this.query(`etf/${endpoint}`, params);
  }

  /** /api/v1/currency/* — FX historical, search, snapshots */
  currency(endpoint: string, params?: Record<string, string>): Promise<unknown[]> {
    return this.query(`currency/${endpoint}`, params);
  }

  /** /api/v1/coverage/* — Provider/endpoint metadata */
  coverage(endpoint: string): Promise<unknown[]> {
    return this.query(`coverage/${endpoint}`);
  }

  /** /api/v1/ta/* — Technical Analysis indicators (sma, ema, rsi, macd, bbands) */
  ta(indicator: string, params?: Record<string, string>): Promise<unknown[]> {
    return this.query(`ta/${indicator}`, params);
  }

  /* ============================================================
   * Typed convenience methods (OHLCV + Ticker)
   * ============================================================ */

  async getOHLCV(params: {
    symbol: string;
    market: string;
    timeframe: string;
    since?: number;
    limit?: number;
  }): Promise<OHLCV[]> {
    const { symbol, market } = params;
    const queryParams: Record<string, string> = { symbol };

    if (params.since) {
      queryParams.start_date = new Date(params.since).toISOString().slice(0, 10);
    }

    if (market === "crypto") {
      queryParams.provider = "ccxt";
      const results = await this.crypto("price/historical", queryParams);
      return this.normalizeOHLCV(results, params.limit);
    }

    if (market === "equity") {
      queryParams.provider = detectEquityProvider(symbol);
      const results = await this.equity("price/historical", queryParams);
      return this.normalizeOHLCV(results, params.limit);
    }

    throw new Error(`DataHub: unsupported market "${market}" for OHLCV`);
  }

  async getTicker(symbol: string, market: string): Promise<Ticker> {
    const queryParams: Record<string, string> = { symbol };

    if (market === "crypto") {
      queryParams.provider = "ccxt";
      const results = await this.crypto("price/historical", queryParams);
      const last = results[results.length - 1] as Record<string, unknown> | undefined;
      return {
        symbol,
        market: "crypto",
        last: Number(last?.close ?? 0),
        timestamp: last?.date ? new Date(String(last.date)).getTime() : Date.now(),
      };
    }

    // Equity ticker — fetch latest bar
    queryParams.provider = detectEquityProvider(symbol);
    queryParams.limit = "1";
    const results = await this.equity("price/historical", queryParams);
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

  /* ============================================================
   * Internal helpers
   * ============================================================ */

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

/** Detect the best DataHub provider for an equity symbol. */
function detectEquityProvider(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (
    upper.endsWith(".SH") ||
    upper.endsWith(".SZ") ||
    upper.endsWith(".BJ") ||
    upper.endsWith(".HK") ||
    /^\d{6}/.test(upper)
  ) {
    return "tushare";
  }
  return "massive";
}
