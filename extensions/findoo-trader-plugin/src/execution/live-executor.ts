/**
 * LiveExecutor — wraps ExchangeRegistry + CcxtBridge to provide a clean
 * live-order execution interface. This is the fix for the L3_LIVE broken
 * path where fin-strategy-engine called ExchangeRegistry.createOrder()
 * which never existed.
 *
 * Registered as service "fin-live-executor".
 */

import { CcxtBridge } from "./ccxt-bridge.js";

type ExchangeRegistryLike = {
  getInstance: (id: string) => Promise<unknown>;
  listExchanges: () => Array<{ id: string; exchange: string; testnet: boolean }>;
};

export class LiveExecutor {
  constructor(private registry: ExchangeRegistryLike) {}

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
    const result = await bridge.placeOrder({
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      amount: params.amount,
      price: params.price,
      params: params.params,
    });
    return { ...result, exchangeId: id, testnet };
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
}
