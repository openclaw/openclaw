/**
 * Screening Pipeline: quick backtest + pass/fail check for strategy candidates.
 *
 * Runs a short backtest per strategy and checks minimum thresholds
 * (Sharpe, drawdown, trade count) to filter out weak candidates early.
 */

import type { BacktestResult } from "../shared/types.js";
import type { ScreeningResult } from "./types.js";

// Duck-typed to avoid circular imports
interface BacktestServiceLike {
  runBacktest(params: { strategyId: string; months?: number }): Promise<BacktestResult | null>;
}

// Screening thresholds
const MIN_SHARPE = 0.5;
const MAX_DRAWDOWN = -30; // percent (negative)
const MIN_TRADES = 50;

export class ScreeningPipeline {
  constructor(private deps: { backtestService: BacktestServiceLike }) {}

  async screen(strategyIds: string[]): Promise<ScreeningResult[]> {
    const results: ScreeningResult[] = [];

    for (const strategyId of strategyIds) {
      try {
        const bt = await this.deps.backtestService.runBacktest({
          strategyId,
          months: 6,
        });

        if (!bt) {
          results.push({
            strategyId,
            passed: false,
            quickBacktest: { sharpe: 0, maxDD: 0, trades: 0 },
            perturbationStability: 0,
            failReason: "Backtest returned no result",
          });
          continue;
        }

        const failReasons: string[] = [];

        if (bt.sharpe < MIN_SHARPE) {
          failReasons.push(`Sharpe ${bt.sharpe.toFixed(2)} < ${MIN_SHARPE}`);
        }
        if (bt.maxDrawdown < MAX_DRAWDOWN) {
          failReasons.push(`MaxDD ${bt.maxDrawdown.toFixed(1)}% < ${MAX_DRAWDOWN}%`);
        }
        if (bt.totalTrades < MIN_TRADES) {
          failReasons.push(`Trades ${bt.totalTrades} < ${MIN_TRADES}`);
        }

        // TODO: Perturbation stability check — run 3 more backtests with +/-10%
        // parameter variations and verify results remain within thresholds.
        // For now, set stability to 1.0 if passed, 0.0 if failed.

        results.push({
          strategyId,
          passed: failReasons.length === 0,
          quickBacktest: {
            sharpe: bt.sharpe,
            maxDD: bt.maxDrawdown,
            trades: bt.totalTrades,
          },
          perturbationStability: failReasons.length === 0 ? 1.0 : 0.0,
          failReason: failReasons.length > 0 ? failReasons.join("; ") : undefined,
        });
      } catch (err) {
        results.push({
          strategyId,
          passed: false,
          quickBacktest: { sharpe: 0, maxDD: 0, trades: 0 },
          perturbationStability: 0,
          failReason: `Backtest error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return results;
  }
}
