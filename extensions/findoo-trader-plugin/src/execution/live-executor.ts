/**
 * LiveExecutor — wraps ExchangeRegistry + CcxtBridge to provide a clean
 * live-order execution interface. This is the fix for the L3_LIVE broken
 * path where fin-strategy-engine called ExchangeRegistry.createOrder()
 * which never existed.
 *
 * Registered as service "fin-live-executor".
 */

import { CcxtBridge } from "./ccxt-bridge.js";
import type { OrderTracker } from "./order-tracker.js";

type ExchangeRegistryLike = {
  getInstance: (id: string) => Promise<unknown>;
  listExchanges: () => Array<{ id: string; exchange: string; testnet: boolean }>;
};

export class LiveExecutor {
  private tracker?: OrderTracker;

  constructor(registry: ExchangeRegistryLike, tracker?: OrderTracker) {
    this.registry = registry;
    this.tracker = tracker;
  }

  private registry: ExchangeRegistryLike;

  /** Resolve the default exchange ID (first configured). */
  private resolveExchangeId(exchangeId?: string): string {
    const id = exchangeId?.trim() ?? "";
    if (id) return id;
    const exchanges = this.registry.listExchanges();
    if (exchanges.length === 0) {
      throw new Error(
        "No exchanges configured. Add one via config financial.exchanges or run: openfinclaw exchange add <name>",
      );
    }
    return exchanges[0].id;
  }

  /** Get a CcxtBridge for the given exchange. */
  private async getBridge(
    exchangeId?: string,
  ): Promise<{ bridge: CcxtBridge; id: string; testnet: boolean }> {
    const id = this.resolveExchangeId(exchangeId);
    const exchanges = this.registry.listExchanges();
    const meta = exchanges.find((e) => e.id === id);
    const instance = await this.registry.getInstance(id);
    return { bridge: new CcxtBridge(instance), id, testnet: meta?.testnet ?? false };
  }

  /**
   * Place a live order on an exchange.
   * This is the primary method used by fin-strategy-engine L3_LIVE path.
   */
  async placeOrder(params: {
    exchangeId?: string;
    symbol: string;
    side: "buy" | "sell";
    type: "market" | "limit";
    amount: number;
    price?: number;
    params?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const { bridge, id, testnet } = await this.getBridge(params.exchangeId);

    // Write-ahead: record SUBMITTED before exchange call
    const trackingId = this.tracker?.recordSubmitted({
      exchangeId: id,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      amount: params.amount,
      price: params.price,
    });

    try {
      const result = await bridge.placeOrder({
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        amount: params.amount,
        price: params.price,
        params: params.params,
      });

      // Mark as FILLED on success
      if (trackingId) {
        const exchangeOrderId = (result as Record<string, unknown>).id as string | undefined;
        this.tracker?.updateStatus(trackingId, "FILLED", exchangeOrderId);
      }

      return { ...result, exchangeId: id, testnet, trackingId };
    } catch (err) {
      // Mark as FAILED on error
      if (trackingId) {
        this.tracker?.updateStatus(
          trackingId,
          "FAILED",
          undefined,
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err;
    }
  }

  /**
   * createOrder() — compatibility wrapper matching the signature that
   * fin-strategy-engine L3_LIVE originally expected from ExchangeRegistry.
   * Signature: createOrder(symbol, type, side, quantity, price?)
   */
  async createOrder(
    symbol: string,
    type: string,
    side: string,
    quantity: number,
    price?: number,
  ): Promise<Record<string, unknown>> {
    return this.placeOrder({
      symbol,
      side: side as "buy" | "sell",
      type: type as "market" | "limit",
      amount: quantity,
      price: price ?? undefined,
    });
  }

  async cancelOrder(
    exchangeId: string | undefined,
    orderId: string,
    symbol: string,
  ): Promise<Record<string, unknown>> {
    const { bridge } = await this.getBridge(exchangeId);
    return bridge.cancelOrder(orderId, symbol);
  }

  async fetchPositions(exchangeId?: string, symbol?: string): Promise<unknown[]> {
    const { bridge } = await this.getBridge(exchangeId);
    return bridge.fetchPositions(symbol);
  }

  async fetchBalance(exchangeId?: string): Promise<Record<string, unknown>> {
    const { bridge } = await this.getBridge(exchangeId);
    return bridge.fetchBalance();
  }

  async fetchOpenOrders(exchangeId?: string, symbol?: string): Promise<unknown[]> {
    const { bridge } = await this.getBridge(exchangeId);
    return bridge.fetchOpenOrders(symbol);
  }

  async fetchOrder(
    exchangeId: string | undefined,
    orderId: string,
    symbol: string,
  ): Promise<Record<string, unknown>> {
    const { bridge } = await this.getBridge(exchangeId);
    return bridge.fetchOrder(orderId, symbol);
  }

  /**
   * Reconcile in-flight orders: scan SUBMITTED orders and check their
   * actual status on the exchange. Call after restart to resolve orphans.
   */
  async reconcileInflight(): Promise<{ reconciled: number; errors: number }> {
    if (!this.tracker) return { reconciled: 0, errors: 0 };
    const submitted = this.tracker.getSubmitted();
    let reconciled = 0;
    let errors = 0;

    for (const order of submitted) {
      if (!order.exchangeOrderId) {
        // No exchange order ID — likely never reached exchange; mark FAILED
        this.tracker.updateStatus(order.id, "FAILED", undefined, "No exchange order ID (orphaned)");
        reconciled++;
        continue;
      }

      try {
        const result = await this.fetchOrder(order.exchangeId, order.exchangeOrderId, order.symbol);
        const status = (result as Record<string, unknown>).status as string | undefined;
        if (status === "closed" || status === "filled") {
          this.tracker.updateStatus(order.id, "FILLED", order.exchangeOrderId);
        } else if (status === "canceled" || status === "cancelled") {
          this.tracker.updateStatus(order.id, "CANCELLED", order.exchangeOrderId);
        }
        // else still open — leave as SUBMITTED
        reconciled++;
      } catch {
        errors++;
      }
    }

    return { reconciled, errors };
  }

  /** Cancel all open orders across all configured exchanges. */
  async cancelAllOpenOrders(): Promise<{ cancelled: number; errors: number }> {
    let cancelled = 0;
    let errors = 0;
    const exchanges = this.registry.listExchanges();

    for (const ex of exchanges) {
      try {
        const { bridge } = await this.getBridge(ex.id);
        const openOrders = (await bridge.fetchOpenOrders()) as Array<{
          id?: string;
          symbol?: string;
        }>;
        for (const order of openOrders) {
          try {
            if (order.id && order.symbol) {
              await bridge.cancelOrder(order.id, order.symbol);
              cancelled++;
            }
          } catch {
            errors++;
          }
        }
      } catch {
        errors++;
      }
    }

    return { cancelled, errors };
  }
}
