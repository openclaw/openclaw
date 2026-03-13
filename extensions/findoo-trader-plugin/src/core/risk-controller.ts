import type { OrderRequest, RiskEvaluation, TradingRiskConfig } from "../types.js";
import type { RiskStateStore } from "./risk-state-store.js";

/**
 * Evaluates trade requests against configured risk limits.
 * Returns a tiered decision: auto-execute, require confirmation, or reject.
 *
 * When a RiskStateStore is provided, dailyLossUsd, dailyLossResetDate, and
 * paused state are persisted to SQLite and survive gateway restarts.
 */
export class RiskController {
  private dailyLossUsd = 0;
  private dailyLossResetDate = "";
  private paused = false;
  private store?: RiskStateStore;

  constructor(config: TradingRiskConfig, store?: RiskStateStore) {
    this.config = config;
    this.store = store;

    // Restore persisted state if store is provided
    if (store) {
      this.paused = store.getPaused();
      const todayState = store.getTodayLoss();
      if (todayState) {
        this.dailyLossUsd = todayState.lossUsd;
        this.dailyLossResetDate = todayState.date;
      }
    }
  }

  private config: TradingRiskConfig;

  pause(): void {
    this.paused = true;
    this.store?.setPaused(true);
  }

  resume(): void {
    this.paused = false;
    this.store?.setPaused(false);
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Reset daily loss tracking if the date has changed. */
  private resetDailyIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyLossResetDate) {
      this.dailyLossUsd = 0;
      this.dailyLossResetDate = today;
    }
  }

  /** Record a realized loss for daily tracking. */
  recordLoss(usdAmount: number): void {
    this.resetDailyIfNeeded();
    this.dailyLossUsd += Math.abs(usdAmount);
    if (this.store) {
      this.store.recordLoss(this.dailyLossResetDate, this.dailyLossUsd);
    }
  }

  /** Return a snapshot of daily loss state (for health probe). */
  getDailyLossState(): { date: string; lossUsd: number; paused: boolean } {
    this.resetDailyIfNeeded();
    return {
      date: this.dailyLossResetDate,
      lossUsd: this.dailyLossUsd,
      paused: this.paused,
    };
  }

  /** Evaluate a trade request against risk rules. */
  evaluate(order: OrderRequest, estimatedValueUsd: number): RiskEvaluation {
    if (!this.config.enabled) {
      return {
        tier: "reject",
        reason: "Trading is disabled. Set financial.trading.enabled=true in config.",
      };
    }

    if (this.paused) {
      return {
        tier: "reject",
        reason: "Trading paused (emergency stop). Use /resume to restore.",
      };
    }

    this.resetDailyIfNeeded();

    // Check daily loss limit.
    if (this.dailyLossUsd >= this.config.maxDailyLossUsd) {
      return {
        tier: "reject",
        reason: `Daily loss limit reached ($${this.dailyLossUsd.toFixed(2)} / $${this.config.maxDailyLossUsd}). Trading halted until tomorrow.`,
      };
    }

    // Check leverage limit.
    if (order.leverage && order.leverage > this.config.maxLeverage) {
      return {
        tier: "reject",
        reason: `Leverage ${order.leverage}x exceeds maximum ${this.config.maxLeverage}x.`,
      };
    }

    // Check pair allowlist/blocklist.
    if (this.config.allowedPairs?.length && !this.config.allowedPairs.includes(order.symbol)) {
      return {
        tier: "reject",
        reason: `${order.symbol} is not in the allowed trading pairs list.`,
      };
    }

    if (this.config.blockedPairs?.includes(order.symbol)) {
      return {
        tier: "reject",
        reason: `${order.symbol} is in the blocked trading pairs list.`,
      };
    }

    // Tier 1: Auto-execute for small trades.
    if (estimatedValueUsd <= this.config.maxAutoTradeUsd) {
      return { tier: "auto" };
    }

    // Tier 2: Require confirmation for medium trades.
    if (estimatedValueUsd <= this.config.confirmThresholdUsd) {
      return {
        tier: "confirm",
        reason: `Trade value $${estimatedValueUsd.toFixed(2)} exceeds auto-trade limit ($${this.config.maxAutoTradeUsd}). Please confirm.`,
      };
    }

    // Tier 3: Reject large trades.
    return {
      tier: "reject",
      reason: `Trade value $${estimatedValueUsd.toFixed(2)} exceeds confirmation threshold ($${this.config.confirmThresholdUsd}). Reduce size or adjust limits.`,
    };
  }

  /** Return a snapshot of the current risk configuration. */
  getConfig(): TradingRiskConfig {
    return { ...this.config };
  }

  /** Update risk configuration. */
  updateConfig(config: Partial<TradingRiskConfig>): void {
    Object.assign(this.config, config);
  }
}
