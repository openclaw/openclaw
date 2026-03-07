import { randomUUID } from "node:crypto";
import { DecayDetector } from "./decay-detector.js";
import { calculateCommission } from "./fill-simulation/commission-model.js";
import { applyConstantSlippage } from "./fill-simulation/constant-slippage.js";
import { validateLotSize } from "./market-rules/lot-size-validator.js";
import { resolveMarket, isMarketOpen } from "./market-rules/market-calendar.js";
import { MARKET_REGISTRY } from "./market-rules/markets/index.js";
import { checkPriceLimit } from "./market-rules/price-limit-validator.js";
import type { ExtendedMarketType } from "./market-rules/types.js";
import { PaperAccount } from "./paper-account.js";
import { PaperStore } from "./paper-store.js";
import type { PaperAccountState, PaperOrder, DecayState } from "./types.js";

export class PaperEngine {
  private store: PaperStore;
  private slippageBps: number;
  private market: string;
  private accounts: Map<string, PaperAccount> = new Map();
  private decayDetector = new DecayDetector();

  constructor(params: { store: PaperStore; slippageBps: number; market: string }) {
    this.store = params.store;
    this.slippageBps = params.slippageBps;
    this.market = params.market;
  }

  createAccount(name: string, capital: number): PaperAccountState {
    const id = `paper-${randomUUID().slice(0, 8)}`;
    const account = new PaperAccount({ id, name, initialCapital: capital });
    this.accounts.set(id, account);

    const state = account.getState();
    this.store.saveAccount(state);
    return state;
  }

  submitOrder(
    accountId: string,
    order: {
      symbol: string;
      side: "buy" | "sell";
      type: "market" | "limit";
      quantity: number;
      limitPrice?: number;
      stopLoss?: number;
      takeProfit?: number;
      reason?: string;
      strategyId?: string;
      prevClose?: number;
      isSt?: boolean;
    },
    currentPrice: number,
  ): PaperOrder {
    const account = this.loadAccount(accountId);
    if (!account) {
      return {
        id: randomUUID(),
        accountId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        limitPrice: order.limitPrice,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        status: "rejected",
        createdAt: Date.now(),
        reason: "Account not found",
        strategyId: order.strategyId,
      };
    }

    // Check market hours
    const market = resolveMarket(order.symbol);
    if (!isMarketOpen(market)) {
      return {
        id: randomUUID(),
        accountId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        status: "rejected",
        createdAt: Date.now(),
        reason: `Market ${market} is currently closed`,
        strategyId: order.strategyId,
        market,
      };
    }

    // Lot size validation
    const lotCheck = validateLotSize(market, order.side, order.quantity);
    if (!lotCheck.valid) {
      return {
        id: randomUUID(),
        accountId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        status: "rejected",
        createdAt: Date.now(),
        reason: lotCheck.reason,
        strategyId: order.strategyId,
        market,
      };
    }

    // T+1 sellable quantity check
    if (order.side === "sell") {
      const sellable = account.getSellableQuantity(order.symbol);
      if (sellable < order.quantity) {
        return {
          id: randomUUID(),
          accountId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          quantity: order.quantity,
          status: "rejected",
          createdAt: Date.now(),
          reason: `Insufficient sellable quantity (T+1 settlement). Sellable: ${sellable}, requested: ${order.quantity}`,
          strategyId: order.strategyId,
          market,
        };
      }
    }

    // For limit orders, check if limit price condition is met
    if (order.type === "limit" && order.limitPrice != null) {
      const limitMet =
        order.side === "buy" ? currentPrice <= order.limitPrice : currentPrice >= order.limitPrice;
      if (!limitMet) {
        return {
          id: randomUUID(),
          accountId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          quantity: order.quantity,
          limitPrice: order.limitPrice,
          status: "pending",
          createdAt: Date.now(),
          reason: "Limit price not reached",
          strategyId: order.strategyId,
          market,
        };
      }
    }

    // Apply slippage
    const { fillPrice, slippageCost } = applyConstantSlippage(
      currentPrice,
      order.side,
      this.slippageBps,
    );

    // Price limit check (after slippage, before execution)
    const limitCheck = checkPriceLimit(market, order.symbol, fillPrice, order.prevClose, {
      isSt: order.isSt,
    });
    if (!limitCheck.valid) {
      return {
        id: randomUUID(),
        accountId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        status: "rejected",
        createdAt: Date.now(),
        reason: limitCheck.reason,
        strategyId: order.strategyId,
        market,
      };
    }

    // Calculate commission
    const notional = fillPrice * order.quantity;
    const { commission } = calculateCommission(notional, market, { side: order.side });

    // Calculate settlement time for T+N markets
    const marketDef = MARKET_REGISTRY[market];
    const settlableAfter =
      marketDef && marketDef.settlement.tPlusDays > 0
        ? Date.now() + marketDef.settlement.tPlusDays * 86_400_000
        : undefined;

    // Execute
    let result: PaperOrder;
    if (order.side === "buy") {
      result = account.executeBuy({
        symbol: order.symbol,
        quantity: order.quantity,
        fillPrice,
        commission,
        slippage: slippageCost,
        reason: order.reason,
        strategyId: order.strategyId,
        settlableAfter,
      });
    } else {
      result = account.executeSell({
        symbol: order.symbol,
        quantity: order.quantity,
        fillPrice,
        commission,
        slippage: slippageCost,
        reason: order.reason,
        strategyId: order.strategyId,
      });
    }

    // Attach market type to order
    result.market = market;

    // Persist
    this.store.saveOrder(result);
    this.store.saveAccount(account.getState());

    return result;
  }

  /** Update market prices for an account's positions and persist the snapshot. */
  updatePrices(accountId: string, prices: Record<string, number>): PaperAccountState | null {
    const account = this.loadAccount(accountId);
    if (!account) return null;

    account.updatePrices(prices);
    const state = account.getState();
    this.store.saveAccount(state);
    return state;
  }

  /** Record an equity snapshot for decay detection. */
  recordSnapshot(accountId: string): void {
    const account = this.loadAccount(accountId);
    if (!account) return;

    const state = account.getState();
    const positionsValue = state.positions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);
    const prevSnapshots = this.store.getSnapshots(accountId);
    const prevEquity =
      prevSnapshots.length > 0
        ? prevSnapshots[prevSnapshots.length - 1]!.equity
        : state.initialCapital;
    const dailyPnl = state.equity - prevEquity;
    const dailyPnlPct = prevEquity > 0 ? (dailyPnl / prevEquity) * 100 : 0;

    this.store.saveSnapshot({
      accountId,
      timestamp: Date.now(),
      equity: state.equity,
      cash: state.cash,
      positionsValue,
      dailyPnl,
      dailyPnlPct,
    });
  }

  getAccountState(accountId: string): PaperAccountState | null {
    const account = this.loadAccount(accountId);
    return account?.getState() ?? null;
  }

  /** Retrieve equity snapshots for the given account (used by dashboard equity curve). */
  getSnapshots(accountId: string): import("./types.js").EquitySnapshot[] {
    return this.store.getSnapshots(accountId);
  }

  /** Retrieve orders for the given account. */
  getOrders(accountId: string, limit?: number): import("./types.js").PaperOrder[] {
    return this.store.getOrders(accountId, limit);
  }

  getMetrics(accountId: string): DecayState | null {
    const account = this.loadAccount(accountId);
    if (!account) return null;

    const snapshots = this.store.getSnapshots(accountId);
    return this.decayDetector.evaluate(snapshots);
  }

  listAccounts(): Array<{ id: string; name: string; equity: number }> {
    return this.store.listAccounts().map((a) => ({
      id: a.id,
      name: a.name,
      equity: a.equity,
    }));
  }

  /** Load account from cache or DB. */
  private loadAccount(accountId: string): PaperAccount | null {
    const cached = this.accounts.get(accountId);
    if (cached) return cached;

    const state = this.store.loadAccount(accountId);
    if (!state) return null;

    const account = PaperAccount.fromState(state);
    this.accounts.set(accountId, account);
    return account;
  }
}
