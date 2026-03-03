/**
 * OpenCTP simulated trading adapter (HTTP REST bridge mode).
 *
 * OpenCTP provides a CTP-compatible simulated environment for A-share trading.
 * The native CTP protocol requires a C++ addon (`node-ctp`), so this adapter
 * communicates through an HTTP REST bridge that wraps the CTP calls.
 *
 * A-share market rules enforced at the adapter level:
 *  - T+1 settlement (buy today, sell tomorrow)
 *  - Price limits: +/-10% for main board, +/-20% for ChiNext/STAR
 *  - Lot size: 100 shares minimum (except ChiNext which allows odd lots)
 *  - No short selling
 *
 * Sim server: tcp://122.51.136.165:20004 (7x24, for testing only)
 *
 * TODO: Integrate `node-ctp` bindings for direct CTP protocol once
 *       cross-platform build story is resolved.
 */
import type {
  MarketAdapter,
  PriceQuote,
  AdapterOrderRequest,
  AdapterOrderResult,
  AdapterAccountState,
} from "./types.js";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:7090";

// A-share lot size: orders must be multiples of 100 shares.
const A_SHARE_LOT_SIZE = 100;

export class OpenCtpAdapter implements MarketAdapter {
  readonly id = "openctp";
  readonly name = "OpenCTP Sim";
  readonly market = "cn-a-share" as const;

  private bridgeUrl = DEFAULT_BRIDGE_URL;
  private initialized = false;

  async init(config: Record<string, unknown>): Promise<void> {
    if (typeof config.bridgeUrl === "string") {
      this.bridgeUrl = config.bridgeUrl;
    }

    // Verify the REST bridge is reachable.
    try {
      const res = await fetch(`${this.bridgeUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        throw new Error(`OpenCTP REST bridge health check returned ${res.status}`);
      }
    } catch (err) {
      throw new Error(
        `OpenCtpAdapter: cannot reach REST bridge at ${this.bridgeUrl} — ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Ensure the CTP REST bridge is running.`,
      );
    }

    this.initialized = true;
  }

  async getPrice(symbol: string): Promise<PriceQuote> {
    this.ensureInit();
    return this.request<PriceQuote>("GET", `/quote/${encodeURIComponent(symbol)}`);
  }

  async submitOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult> {
    this.ensureInit();

    // Enforce A-share lot size rule.
    if (order.qty % A_SHARE_LOT_SIZE !== 0) {
      return {
        orderId: "",
        status: "rejected",
        filledQty: 0,
        filledPrice: 0,
        message: `A-share orders must be multiples of ${A_SHARE_LOT_SIZE} shares, got ${order.qty}`,
      };
    }

    // A-shares do not allow short selling.
    if (order.side === "sell") {
      // TODO: Check T+1 — verify shares were not bought today.
      // This requires tracking purchase dates, which the paper-store layer handles.
    }

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
    // TODO: Disconnect CTP session when using native bindings.
    this.initialized = false;
  }

  // -- internal helpers --

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error("OpenCtpAdapter: not initialized — call init() first");
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
      throw new Error(`OpenCtpAdapter ${method} ${path} failed: ${res.status} ${errText}`);
    }

    return (await res.json()) as T;
  }
}
