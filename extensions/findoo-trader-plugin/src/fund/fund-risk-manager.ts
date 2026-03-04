import type { FundConfig, FundRiskStatus, Allocation } from "./types.js";

/**
 * Fund-level risk management.
 *
 * Rules:
 *   normal:   All clear
 *   caution:  Daily drawdown > 3% — reduce new entries
 *   warning:  Daily drawdown > 5% — shrink all positions 50%
 *   critical: Daily drawdown > 10% — halt all trading + notify
 */
export class FundRiskManager {
  private todayStartEquity = 0;
  private peakEquity = 0;

  constructor(private config: FundConfig) {}

  /** Set the baseline equity at day start. */
  markDayStart(equity: number): void {
    this.todayStartEquity = equity;
    if (equity > this.peakEquity) this.peakEquity = equity;
  }

  /** Evaluate current fund risk status. */
  evaluate(currentEquity: number, allocations: Allocation[]): FundRiskStatus {
    if (currentEquity > this.peakEquity) this.peakEquity = currentEquity;

    const todayPnl = currentEquity - this.todayStartEquity;
    const todayPnlPct = this.todayStartEquity > 0 ? (todayPnl / this.todayStartEquity) * 100 : 0;
    const dailyDrawdown = todayPnlPct < 0 ? Math.abs(todayPnlPct) : 0;

    const totalAllocated = allocations.reduce((sum, a) => sum + a.capitalUsd, 0);
    const exposurePct = currentEquity > 0 ? (totalAllocated / currentEquity) * 100 : 0;
    const cashReservePct =
      currentEquity > 0 ? ((currentEquity - totalAllocated) / currentEquity) * 100 : 100;

    let riskLevel: FundRiskStatus["riskLevel"] = "normal";
    if (dailyDrawdown > 10) riskLevel = "critical";
    else if (dailyDrawdown > 5) riskLevel = "warning";
    else if (dailyDrawdown > 3) riskLevel = "caution";

    return {
      totalEquity: currentEquity,
      todayPnl: Math.round(todayPnl * 100) / 100,
      todayPnlPct: Math.round(todayPnlPct * 100) / 100,
      dailyDrawdown: Math.round(dailyDrawdown * 100) / 100,
      maxAllowedDrawdown: 10,
      riskLevel,
      activeStrategies: allocations.length,
      exposurePct: Math.round(exposurePct * 100) / 100,
      cashReservePct: Math.round(cashReservePct * 100) / 100,
    };
  }

  /**
   * Compute position scale factor based on risk level.
   * Used to shrink positions during drawdowns.
   */
  getScaleFactor(riskLevel: FundRiskStatus["riskLevel"]): number {
    switch (riskLevel) {
      case "normal":
        return 1.0;
      case "caution":
        return 0.8;
      case "warning":
        return 0.5;
      case "critical":
        return 0; // halt
    }
  }

  /** Update config. */
  updateConfig(config: Partial<FundConfig>): void {
    Object.assign(this.config, config);
  }
}
