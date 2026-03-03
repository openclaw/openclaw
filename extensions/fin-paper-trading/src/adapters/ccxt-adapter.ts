/**
 * CCXT-based crypto exchange adapter.
 *
 * Supports binance, okx, bybit, hyperliquid (and any CCXT-compatible exchange).
 * Fully functional — uses the ccxt package already in root dependencies.
 */
import type {
  MarketAdapter,
  PriceQuote,
  AdapterOrderRequest,
  AdapterOrderResult,
  AdapterAccountState,
  AdapterPosition,
} from "./types.js";

const SUPPORTED_EXCHANGES = new Set(["binance", "okx", "bybit", "hyperliquid"]);

export class CcxtAdapter implements MarketAdapter {
  readonly market = "crypto" as const;

  private exchange: Record<string, unknown> | null = null;
  private exchangeName = "";

  get id(): string {
    return this.exchangeName || "ccxt";
  }

  get name(): string {
    return this.exchangeName ? `${this.exchangeName} (CCXT)` : "CCXT";
  }

  async init(config: Record<string, unknown>): Promise<void> {
    const exchangeName = String(config.exchange ?? "");
    const apiKey = String(config.apiKey ?? "");
    const secret = String(config.secret ?? "");

    if (!exchangeName) {
      throw new Error("CcxtAdapter: exchange name is required");
    }
    if (!apiKey || !secret) {
      throw new Error("CcxtAdapter: apiKey and secret are required");
    }
    if (!SUPPORTED_EXCHANGES.has(exchangeName)) {
      throw new Error(
        `CcxtAdapter: unsupported exchange "${exchangeName}". ` +
          `Supported: ${[...SUPPORTED_EXCHANGES].join(", ")}`,
      );
    }

    this.exchangeName = exchangeName;

    const ccxt = await import("ccxt");
    const ExchangeClass = (ccxt as Record<string, unknown>)[exchangeName];
    if (typeof ExchangeClass !== "function") {
      throw new Error(`CcxtAdapter: exchange class "${exchangeName}" not found in ccxt`);
    }

    const opts: Record<string, unknown> = {
      apiKey,
      secret,
      enableRateLimit: true,
      timeout: 15_000,
    };

    if (config.passphrase) {
      opts.password = String(config.passphrase);
    }

    this.exchange = new (ExchangeClass as new (o: Record<string, unknown>) => Record<string, unknown>)(opts);

    // Enable testnet/sandbox if requested
    if (config.testnet === true && typeof this.ex().setSandboxMode === "function") {
      (this.ex() as { setSandboxMode: (v: boolean) => void }).setSandboxMode(true);
    }
  }

  async getPrice(symbol: string): Promise<PriceQuote> {
    const ticker = await this.call("fetchTicker", symbol) as {
      last?: number;
      bid?: number;
      ask?: number;
      timestamp?: number;
    };

    const last = ticker.last ?? ((ticker.bid ?? 0) + (ticker.ask ?? 0)) / 2;
    return {
      last,
      bid: ticker.bid ?? undefined,
      ask: ticker.ask ?? undefined,
      timestamp: ticker.timestamp ?? Date.now(),
    };
  }

  async submitOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult> {
    try {
      const result = await this.call(
        "createOrder",
        order.symbol,
        order.type,
        order.side,
        order.qty,
        order.type === "limit" ? order.limitPrice : undefined,
      ) as {
        id: string;
        status: string;
        filled?: number;
        average?: number;
        price?: number;
      };

      return {
        orderId: result.id,
        status: mapCcxtStatus(result.status),
        filledQty: result.filled ?? 0,
        filledPrice: result.average ?? result.price ?? 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Insufficient funds, invalid order etc. → rejected (not thrown)
      if (isOrderRejection(msg)) {
        return {
          orderId: "",
          status: "rejected",
          filledQty: 0,
          filledPrice: 0,
          message: msg,
        };
      }
      throw err;
    }
  }

  async getAccountState(): Promise<AdapterAccountState> {
    const balance = await this.call("fetchBalance") as {
      total?: Record<string, number>;
      free?: Record<string, number>;
      info?: Record<string, unknown>;
    };

    const total = balance.total ?? {};
    const free = balance.free ?? {};

    // Estimate equity from total balances (sum of all non-zero in USDT terms)
    // For a proper equity calc we'd need prices, but for paper trading overview
    // we report the raw totals and let the caller handle valuation.
    let equity = 0;
    const positions: AdapterPosition[] = [];

    for (const [currency, amount] of Object.entries(total)) {
      if (typeof amount !== "number" || amount === 0) continue;

      if (isStablecoin(currency)) {
        equity += amount;
      } else {
        // Non-stablecoin: report as position
        positions.push({
          symbol: `${currency}/USDT`,
          qty: amount,
          avgPrice: 0, // CCXT balance doesn't track avg entry
          currentPrice: 0, // would need fetchTicker per asset
          unrealizedPnl: 0,
        });
      }
    }

    const cash = Object.entries(free)
      .filter(([c]) => isStablecoin(c))
      .reduce((sum, [, v]) => sum + (typeof v === "number" ? v : 0), 0);

    return {
      equity: equity || cash,
      cash,
      buyingPower: cash,
      positions,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.ensureInit();
      await this.call("fetchBalance");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    if (this.exchange && typeof this.ex().close === "function") {
      try {
        await (this.ex() as { close: () => Promise<void> }).close();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.exchange = null;
  }

  // ── internals ──

  private ex(): Record<string, unknown> {
    this.ensureInit();
    return this.exchange!;
  }

  private ensureInit(): void {
    if (!this.exchange) {
      throw new Error("CcxtAdapter: not initialized — call init() first");
    }
  }

  /** Call any CCXT method with automatic error wrapping. */
  private async call(method: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.ex()[method];
    if (typeof fn !== "function") {
      throw new Error(`CcxtAdapter: exchange does not support ${method}`);
    }
    try {
      return await (fn as (...a: unknown[]) => Promise<unknown>).call(this.ex(), ...args);
    } catch (err) {
      const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? "";
      const msg = err instanceof Error ? err.message : String(err);

      if (name === "AuthenticationError" || name === "PermissionDenied") {
        throw new Error(`[${this.exchangeName}] Authentication failed: ${msg}`);
      }
      if (name === "RateLimitExceeded" || name === "DDoSProtection") {
        throw new Error(`[${this.exchangeName}] Rate limited: ${msg}`);
      }
      if (name === "NetworkError" || name === "RequestTimeout" || name === "ExchangeNotAvailable") {
        throw new Error(`[${this.exchangeName}] Network error: ${msg}`);
      }
      throw err;
    }
  }
}

function mapCcxtStatus(status: string): AdapterOrderResult["status"] {
  switch (status) {
    case "closed":
      return "filled";
    case "open":
    case "new":
      return "accepted";
    case "partially_filled":
      return "partial";
    case "canceled":
    case "cancelled":
    case "rejected":
    case "expired":
      return "rejected";
    default:
      return "accepted";
  }
}

function isOrderRejection(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("insufficient") ||
    lower.includes("invalid order") ||
    lower.includes("min notional") ||
    lower.includes("lot size")
  );
}

function isStablecoin(currency: string): boolean {
  const s = currency.toUpperCase();
  return s === "USDT" || s === "USDC" || s === "BUSD" || s === "DAI" || s === "TUSD" || s === "USD";
}
