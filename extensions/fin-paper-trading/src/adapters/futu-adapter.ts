/**
 * Futu OpenD adapter (HTTP REST bridge mode).
 *
 * Futu OpenD provides a TCP/protobuf protocol that normally requires the
 * `futu-api` npm package (C++ addon). This initial implementation assumes
 * a lightweight HTTP REST bridge is running alongside OpenD, exposing a
 * JSON API on the configured host:port.
 *
 * TODO: Integrate `futu-api` npm package for native protobuf connection
 *       once the C++ addon build is stabilized for cross-platform use.
 */
import type {
  MarketAdapter,
  PriceQuote,
  AdapterOrderRequest,
  AdapterOrderResult,
  AdapterAccountState,
} from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 11111;

export class FutuAdapter implements MarketAdapter {
  readonly id = "futu";
  readonly name = "Futu OpenD";
  readonly market = "hk-equity" as const;

  private bridgeUrl = "";
  private initialized = false;

  async init(config: Record<string, unknown>): Promise<void> {
    const host = typeof config.host === "string" ? config.host : DEFAULT_HOST;
    const port = typeof config.port === "number" ? config.port : DEFAULT_PORT;
    this.bridgeUrl = `http://${host}:${port}`;

    // Verify the REST bridge is reachable.
    try {
      const res = await fetch(`${this.bridgeUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        throw new Error(`Futu REST bridge health check returned ${res.status}`);
      }
    } catch (err) {
      throw new Error(
        `FutuAdapter: cannot reach REST bridge at ${this.bridgeUrl} — ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Ensure Futu OpenD + REST bridge are running.`,
      );
    }

    this.initialized = true;
  }

  async getPrice(symbol: string): Promise<PriceQuote> {
    this.ensureInit();
    const res = await this.request<{
      last: number;
      bid?: number;
      ask?: number;
      timestamp: number;
    }>("GET", `/quote/${encodeURIComponent(symbol)}`);
    return res;
  }

  async submitOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult> {
    this.ensureInit();
    return this.request<AdapterOrderResult>("POST", "/order", {
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      type: order.type,
      limitPrice: order.limitPrice,
      timeInForce: order.timeInForce ?? "day",
    });
  }

  async getAccountState(): Promise<AdapterAccountState> {
    this.ensureInit();
    return this.request<AdapterAccountState>("GET", "/account");
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.ensureInit();
      const res = await fetch(`${this.bridgeUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return { ok: res.ok, error: res.ok ? undefined : `status ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    // TODO: Close persistent connections when using native protobuf transport.
    this.initialized = false;
  }

  // -- internal helpers --

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error("FutuAdapter: not initialized — call init() first");
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.bridgeUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`FutuAdapter ${method} ${path} failed: ${res.status} ${errText}`);
    }

    return (await res.json()) as T;
  }
}
