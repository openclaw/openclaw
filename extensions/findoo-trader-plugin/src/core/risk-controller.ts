import type { OrderRequest, RiskEvaluation, TradingRiskConfig } from "../types.js";

/**
 * Evaluates trade requests against configured risk limits.
 * Returns a tiered decision: auto-execute, require confirmation, or reject.
 */
export class RiskController {
  private dailyLossUsd = 0;
  private dailyLossResetDate = "";

  constructor(private config: TradingRiskConfig) {}

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
  }

  /** Evaluate a trade request against risk rules. */
  evaluate(order: OrderRequest, estimatedValueUsd: number): RiskEvaluation {
    if (!this.config.enabled) {
      return {
        tier: "reject",
        reason: "Trading is disabled. Set financial.trading.enabled=true in config.",
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

  /** Update risk configuration. */
  updateConfig(config: Partial<TradingRiskConfig>): void {
    Object.assign(this.config, config);
  }
}
