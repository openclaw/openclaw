import type { BacktestResult, TradeRecord } from "@openfinclaw/fin-shared-types";
import type { RemoteReport, RemoteTradeEntry } from "./types.js";

/**
 * Convert a remote backtest report (v1.1) into the local BacktestResult format.
 *
 * v1.1 changes:
 * - performance fields use short names: sharpe (not sharpeRatio), sortino, calmar
 * - trades live in trade_journal[] with {date, action, amount, price, reason}
 * - equity_curve[] still {date, equity} (may be null)
 */
export function toBacktestResult(
  report: RemoteReport,
  meta: { strategyId: string; initialCapital: number },
): BacktestResult {
  const p = report.performance;
  const trades = (report.trade_journal ?? []).map(mapTradeEntry);
  const equityCurve = (report.equity_curve ?? []).map((pt) => pt.equity);
  const dailyReturns = computeDailyReturns(equityCurve);

  // Derive date range from equity curve
  const dates = (report.equity_curve ?? []).map((pt) => new Date(pt.date).getTime());
  const startDate = dates.length > 0 ? dates[0] : 0;
  const endDate = dates.length > 0 ? dates[dates.length - 1] : 0;

  return {
    strategyId: meta.strategyId,
    startDate,
    endDate,
    initialCapital: meta.initialCapital,
    // v1.1: totalReturn/maxDrawdown/winRate are already percentage values (e.g. -23.91 = -23.91%)
    // Convert to decimal ratio for local BacktestResult (e.g. -0.2391)
    finalEquity: p?.finalEquity ?? meta.initialCapital * (1 + (p?.totalReturn ?? 0) / 100),
    totalReturn: (p?.totalReturn ?? 0) / 100,
    sharpe: p?.sharpe ?? 0,
    sortino: p?.sortino ?? 0,
    maxDrawdown: (p?.maxDrawdown ?? 0) / 100,
    calmar: p?.calmar ?? 0,
    winRate: (p?.winRate ?? 0) / 100,
    profitFactor: p?.profitFactor ?? 0,
    totalTrades: p?.totalTrades ?? 0,
    trades,
    equityCurve,
    dailyReturns,
  };
}

function mapTradeEntry(t: RemoteTradeEntry): TradeRecord {
  const ts = new Date(t.date).getTime();
  return {
    entryTime: ts,
    exitTime: ts, // v1.1 trade_journal has a single date per entry
    symbol: "",
    side: t.action === "buy" ? "long" : "short",
    entryPrice: t.price ?? 0,
    exitPrice: t.price ?? 0,
    quantity: t.amount ?? 0,
    commission: 0,
    slippage: 0,
    pnl: 0, // v1.1 trade_journal does not include pnl
    pnlPct: 0,
    reason: t.reason ?? "",
    exitReason: "",
  };
}

/** Compute daily returns from an equity curve. */
function computeDailyReturns(equityCurve: number[]): number[] {
  if (equityCurve.length < 2) return [];
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1];
    returns.push(prev > 0 ? (equityCurve[i] - prev) / prev : 0);
  }
  return returns;
}
