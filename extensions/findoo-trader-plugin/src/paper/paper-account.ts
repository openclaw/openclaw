import { randomUUID } from "node:crypto";
import type { PaperAccountState, PaperOrder, PaperPosition, PositionLot } from "./types.js";

export class PaperAccount {
  private id: string;
  private name: string;
  private initialCapital: number;
  private cash: number;
  private positions: Map<string, PaperPosition> = new Map();
  private orders: PaperOrder[] = [];
  private createdAt: number;
  private updatedAt: number;

  constructor(params: { id: string; name: string; initialCapital: number }) {
    this.id = params.id;
    this.name = params.name;
    this.initialCapital = params.initialCapital;
    this.cash = params.initialCapital;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  getState(): PaperAccountState {
    return {
      id: this.id,
      name: this.name,
      initialCapital: this.initialCapital,
      cash: this.cash,
      equity: this.getEquity(),
      positions: Array.from(this.positions.values()),
      orders: [...this.orders],
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  executeBuy(params: {
    symbol: string;
    quantity: number;
    fillPrice: number;
    commission: number;
    slippage: number;
    reason?: string;
    strategyId?: string;
    settlableAfter?: number;
  }): PaperOrder {
    const cost = params.fillPrice * params.quantity + params.commission;

    if (cost > this.cash) {
      const order: PaperOrder = {
        id: randomUUID(),
        accountId: this.id,
        symbol: params.symbol,
        side: "buy",
        type: "market",
        quantity: params.quantity,
        status: "rejected",
        fillPrice: params.fillPrice,
        commission: params.commission,
        slippage: params.slippage,
        createdAt: Date.now(),
        reason: params.reason ?? "Insufficient cash",
        strategyId: params.strategyId,
      };
      this.orders.push(order);
      return order;
    }

    this.cash -= cost;

    // Add to existing position or create new one
    const existing = this.positions.get(params.symbol);
    if (existing && existing.side === "long") {
      // Average into existing long position
      const totalQty = existing.quantity + params.quantity;
      const totalCost =
        existing.entryPrice * existing.quantity + params.fillPrice * params.quantity;
      existing.entryPrice = totalCost / totalQty;
      existing.quantity = totalQty;
      existing.unrealizedPnl = (existing.currentPrice - existing.entryPrice) * totalQty;
    } else {
      this.positions.set(params.symbol, {
        symbol: params.symbol,
        side: "long",
        quantity: params.quantity,
        entryPrice: params.fillPrice,
        currentPrice: params.fillPrice,
        unrealizedPnl: 0,
        openedAt: Date.now(),
      });
    }

    // Append settlement lot for T+N tracking
    if (params.settlableAfter != null) {
      const pos = this.positions.get(params.symbol)!;
      if (!pos.lots) pos.lots = [];
      pos.lots.push({
        quantity: params.quantity,
        entryPrice: params.fillPrice,
        settlableAfter: params.settlableAfter,
      });
    }

    this.updatedAt = Date.now();

    const order: PaperOrder = {
      id: randomUUID(),
      accountId: this.id,
      symbol: params.symbol,
      side: "buy",
      type: "market",
      quantity: params.quantity,
      status: "filled",
      fillPrice: params.fillPrice,
      commission: params.commission,
      slippage: params.slippage,
      createdAt: Date.now(),
      filledAt: Date.now(),
      reason: params.reason,
      strategyId: params.strategyId,
    };
    this.orders.push(order);
    return order;
  }

  /** Get the quantity that can be sold now (T+1 aware). */
  getSellableQuantity(symbol: string, now?: number): number {
    const pos = this.positions.get(symbol);
    if (!pos) return 0;
    if (!pos.lots || pos.lots.length === 0) return pos.quantity;
    const ts = now ?? Date.now();
    return pos.lots
      .filter((lot) => ts >= lot.settlableAfter)
      .reduce((sum, lot) => sum + lot.quantity, 0);
  }

  executeSell(params: {
    symbol: string;
    quantity: number;
    fillPrice: number;
    commission: number;
    slippage: number;
    reason?: string;
    strategyId?: string;
  }): PaperOrder {
    const position = this.positions.get(params.symbol);
    if (!position || position.quantity < params.quantity) {
      const order: PaperOrder = {
        id: randomUUID(),
        accountId: this.id,
        symbol: params.symbol,
        side: "sell",
        type: "market",
        quantity: params.quantity,
        status: "rejected",
        fillPrice: params.fillPrice,
        commission: params.commission,
        slippage: params.slippage,
        createdAt: Date.now(),
        reason: params.reason ?? "Insufficient position",
        strategyId: params.strategyId,
      };
      this.orders.push(order);
      return order;
    }

    const proceeds = params.fillPrice * params.quantity - params.commission;
    this.cash += proceeds;

    // Reduce or close position
    position.quantity -= params.quantity;
    if (position.quantity <= 0) {
      this.positions.delete(params.symbol);
    } else {
      position.unrealizedPnl = (position.currentPrice - position.entryPrice) * position.quantity;
      // Consume lots FIFO
      if (position.lots && position.lots.length > 0) {
        let remaining = params.quantity;
        while (remaining > 0 && position.lots.length > 0) {
          const lot = position.lots[0]!;
          if (lot.quantity <= remaining) {
            remaining -= lot.quantity;
            position.lots.shift();
          } else {
            lot.quantity -= remaining;
            remaining = 0;
          }
        }
      }
    }

    this.updatedAt = Date.now();

    const order: PaperOrder = {
      id: randomUUID(),
      accountId: this.id,
      symbol: params.symbol,
      side: "sell",
      type: "market",
      quantity: params.quantity,
      status: "filled",
      fillPrice: params.fillPrice,
      commission: params.commission,
      slippage: params.slippage,
      createdAt: Date.now(),
      filledAt: Date.now(),
      reason: params.reason,
      strategyId: params.strategyId,
    };
    this.orders.push(order);
    return order;
  }

  updatePrices(prices: Record<string, number>): void {
    for (const [symbol, price] of Object.entries(prices)) {
      const position = this.positions.get(symbol);
      if (position) {
        position.currentPrice = price;
        position.unrealizedPnl = (price - position.entryPrice) * position.quantity;
      }
    }
    this.updatedAt = Date.now();
  }

  getEquity(): number {
    let positionsValue = 0;
    for (const pos of this.positions.values()) {
      positionsValue += pos.currentPrice * pos.quantity;
    }
    return this.cash + positionsValue;
  }

  getPosition(symbol: string): PaperPosition | undefined {
    return this.positions.get(symbol);
  }

  getOrderHistory(): PaperOrder[] {
    return this.orders.filter((o) => o.status === "filled");
  }

  /** Restore state from a persisted snapshot (used by PaperStore). */
  static fromState(state: PaperAccountState): PaperAccount {
    const account = new PaperAccount({
      id: state.id,
      name: state.name,
      initialCapital: state.initialCapital,
    });
    account.cash = state.cash;
    account.createdAt = state.createdAt;
    account.updatedAt = state.updatedAt;
    account.orders = [...state.orders];
    for (const pos of state.positions) {
      account.positions.set(pos.symbol, {
        ...pos,
        lots: pos.lots ? pos.lots.map((l) => ({ ...l })) : undefined,
      });
    }
    return account;
  }
}
