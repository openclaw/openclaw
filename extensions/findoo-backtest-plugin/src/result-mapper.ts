import type { BacktestResult, TradeRecord } from "@openfinclaw/fin-shared-types";
import type { RemoteReport, RemoteTrade } from "./types.js";

/**
 * Convert a remote backtest report into the local BacktestResult format.
 *
 * The remote API returns snake_case fields + ISO date strings.
 * Local BacktestResult uses camelCase + Unix timestamps (ms).
 */
export function toBacktestResult(
  report: RemoteReport,
  meta: { strategyId: string; initialCapital: number },
): BacktestResult {
  const s = report.result_summary;
  const trades = (report.trades ?? []).map(mapTrade);
  const equityCurve = (report.equity_curve ?? []).map((pt) => pt.equity);
  const dailyReturns = computeDailyReturns(equityCurve);

  // Derive date range from equity curve or trades
  const dates = (report.equity_curve ?? []).map((pt) => new Date(pt.date).getTime());
  const startDate = dates.length > 0 ? dates[0] : 0;
  const endDate = dates.length > 0 ? dates[dates.length - 1] : 0;

  return {
    strategyId: meta.strategyId,
    startDate,
    endDate,
    initialCapital: meta.initialCapital,
    finalEquity: s.final_equity,
    totalReturn: s.total_return,
    sharpe: s.sharpe_ratio,
    sortino: s.sortino_ratio,
    maxDrawdown: s.max_drawdown,
    calmar: s.calmar_ratio,
    winRate: s.win_rate,
    profitFactor: s.profit_factor,
    totalTrades: s.total_trades,
    trades,
    equityCurve,
    dailyReturns,
  };
}

function mapTrade(t: RemoteTrade): TradeRecord {
  return {
    entryTime: new Date(t.entry_time).getTime(),
    exitTime: new Date(t.exit_time).getTime(),
    symbol: t.symbol,
    side: t.side,
    entryPrice: t.entry_price,
    exitPrice: t.exit_price,
    quantity: t.quantity,
    commission: t.commission,
    slippage: t.slippage,
    pnl: t.pnl,
    pnlPct: t.pnl_pct,
    reason: t.reason,
    exitReason: t.exit_reason,
  };
}

/** Compute daily log returns from an equity curve. */
function computeDailyReturns(equityCurve: number[]): number[] {
  if (equityCurve.length < 2) return [];
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1];
    returns.push(prev > 0 ? (equityCurve[i] - prev) / prev : 0);
  }
  return returns;
}
