import { applyConstantSlippage } from "../../fin-shared-types/src/fill-simulation.js";
import type { OHLCV } from "../../fin-shared-types/src/types.js";
import { sma, ema, rsi, macd, bollingerBands, atr } from "./indicators.js";
import {
  sharpeRatio,
  sortinoRatio,
  maxDrawdown,
  calmarRatio,
  profitFactor,
  winRate,
} from "./stats.js";
import type {
  BacktestConfig,
  BacktestResult,
  IndicatorLib,
  Position,
  Signal,
  StrategyContext,
  StrategyDefinition,
  TradeRecord,
} from "./types.js";

/** Internal mutable position used during simulation. */
interface InternalPosition {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  entryTime: number;
  entryCommission: number;
  reason: string;
}

/** Build an IndicatorLib over history close/high/low arrays. */
export function buildIndicatorLib(history: OHLCV[]): IndicatorLib {
  const closes = history.map((b) => b.close);
  const highs = history.map((b) => b.high);
  const lows = history.map((b) => b.low);

  return {
    sma: (period: number) => sma(closes, period),
    ema: (period: number) => ema(closes, period),
    rsi: (period: number) => rsi(closes, period),
    macd: (fast?: number, slow?: number, signal?: number) => macd(closes, fast, slow, signal),
    bollingerBands: (period?: number, stdDev?: number) => bollingerBands(closes, period, stdDev),
    atr: (period?: number) => atr(highs, lows, closes, period),
  };
}

/**
 * Event-driven bar-by-bar backtest engine.
 * Cash accounting is maintained in real-time — no replay needed.
 */
export class BacktestEngine {
  async run(
    strategy: StrategyDefinition,
    data: OHLCV[],
    config: BacktestConfig,
  ): Promise<BacktestResult> {
    if (data.length === 0) {
      return emptyResult(strategy.id, config.capital);
    }

    let cash = config.capital;
    const positions: InternalPosition[] = [];
    const trades: TradeRecord[] = [];
    const equityCurve: number[] = [];
    const memory = new Map<string, unknown>();

    const getEquity = (price: number) => {
      // Equity = cash + market value of all open positions.
      // For long positions: market value = quantity * currentPrice.
      // Cash was reduced by (quantity * entryPrice + entryCommission) at entry.
      const positionValue = positions.reduce((sum, p) => {
        if (p.side === "long") return sum + p.quantity * price;
        // For short: value = 2 * entryPrice * qty - qty * price (proceeds - current liability)
        return sum + p.quantity * (2 * p.entryPrice - price);
      }, 0);
      return cash + positionValue;
    };

    const buildContext = (barIndex: number): StrategyContext => {
      const history = data.slice(0, barIndex + 1);
      const currentPrice = data[barIndex]!.close;

      const positionSnapshots: Position[] = positions.map((p) => {
        const move = p.side === "long" ? currentPrice - p.entryPrice : p.entryPrice - currentPrice;
        return {
          symbol: p.symbol,
          side: p.side,
          quantity: p.quantity,
          entryPrice: p.entryPrice,
          currentPrice,
          unrealizedPnl: move * p.quantity,
        };
      });

      return {
        portfolio: {
          equity: getEquity(currentPrice),
          cash,
          positions: positionSnapshots,
        },
        history,
        indicators: buildIndicatorLib(history),
        regime: "sideways",
        memory,
        log: () => {},
      };
    };

    // Initialize strategy
    if (strategy.init) {
      await strategy.init(buildContext(0));
    }

    // Main simulation loop
    for (let i = 0; i < data.length; i++) {
      const bar = data[i]!;
      const ctx = buildContext(i);
      const signal = await strategy.onBar(bar, ctx);

      if (signal) {
        this.processSignal(signal, bar, positions, trades, config, {
          get cash() {
            return cash;
          },
          set cash(v: number) {
            cash = v;
          },
        });
      }

      equityCurve.push(getEquity(bar.close));

      if (strategy.onDayEnd) {
        await strategy.onDayEnd(buildContext(i));
      }
    }

    // Close all remaining positions at last bar's close
    const lastBar = data[data.length - 1]!;
    this.closeAllPositions(positions, trades, lastBar, config, {
      get cash() {
        return cash;
      },
      set cash(v: number) {
        cash = v;
      },
    });

    // Update final equity curve entry (now all positions are closed)
    equityCurve[equityCurve.length - 1] = cash;

    const dailyReturns = computeDailyReturns(equityCurve);
    const totalReturn = ((cash - config.capital) / config.capital) * 100;
    const sharpe = sharpeRatio(dailyReturns, 0, true);
    const sortino = sortinoRatio(dailyReturns, 0);
    const dd = maxDrawdown(equityCurve);
    const annualizedReturn = totalReturn * (252 / Math.max(data.length, 1));
    const calmar = calmarRatio(annualizedReturn, dd.maxDD);
    const wins = trades.filter((t) => t.pnl > 0).map((t) => t.pnl);
    const losses = trades.filter((t) => t.pnl <= 0).map((t) => t.pnl);
    const pf = profitFactor(wins, losses);
    const wr = winRate(trades);

    return {
      strategyId: strategy.id,
      startDate: data[0]!.timestamp,
      endDate: lastBar.timestamp,
      initialCapital: config.capital,
      finalEquity: cash,
      totalReturn,
      sharpe: Number.isFinite(sharpe) ? sharpe : 0,
      sortino: Number.isFinite(sortino) ? sortino : 0,
      maxDrawdown: dd.maxDD,
      calmar: Number.isFinite(calmar) ? calmar : 0,
      winRate: Number.isNaN(wr) ? 0 : wr,
      profitFactor: Number.isFinite(pf) ? pf : 0,
      totalTrades: trades.length,
      trades,
      equityCurve,
      dailyReturns,
    };
  }

  /** Process a signal: open or close positions with slippage and commission. */
  private processSignal(
    signal: Signal,
    bar: OHLCV,
    positions: InternalPosition[],
    trades: TradeRecord[],
    config: BacktestConfig,
    wallet: { cash: number },
  ): void {
    if (signal.action === "close") {
      const toClose = [...positions.filter((p) => p.symbol === signal.symbol)];
      for (const pos of toClose) {
        this.closeSinglePosition(pos, bar, positions, trades, config, wallet, "signal-close");
      }
      return;
    }

    if (signal.action === "buy") {
      // Close any short position first
      const shortPos = positions.find((p) => p.symbol === signal.symbol && p.side === "short");
      if (shortPos) {
        this.closeSinglePosition(
          shortPos,
          bar,
          positions,
          trades,
          config,
          wallet,
          "reverse-to-long",
        );
      }

      const { fillPrice } = applyConstantSlippage(bar.close, "buy", config.slippageBps);
      const posValue = positions.reduce((s, p) => {
        if (p.side === "long") return s + p.quantity * bar.close;
        return s + p.quantity * (2 * p.entryPrice - bar.close);
      }, 0);
      const equity = wallet.cash + posValue;
      const allocAmount = equity * (signal.sizePct / 100);
      // Account for commission: allocAmount = quantity * fillPrice * (1 + commissionRate)
      const quantity = allocAmount / (fillPrice * (1 + config.commissionRate));
      if (quantity <= 0) return;

      const notional = quantity * fillPrice;
      const commission = notional * config.commissionRate;
      if (wallet.cash < notional + commission) return;

      wallet.cash -= notional + commission;

      positions.push({
        symbol: signal.symbol,
        side: "long",
        quantity,
        entryPrice: fillPrice,
        entryTime: bar.timestamp,
        entryCommission: commission,
        reason: signal.reason,
      });
    }

    if (signal.action === "sell") {
      const longPos = positions.find((p) => p.symbol === signal.symbol && p.side === "long");
      if (longPos) {
        this.closeSinglePosition(longPos, bar, positions, trades, config, wallet, signal.reason);
      }
    }
  }

  /** Close a single position and record the trade. */
  private closeSinglePosition(
    pos: InternalPosition,
    bar: OHLCV,
    positions: InternalPosition[],
    trades: TradeRecord[],
    config: BacktestConfig,
    wallet: { cash: number },
    exitReason: string,
  ): void {
    const exitSide = pos.side === "long" ? "sell" : "buy";
    const { fillPrice, slippageCost } = applyConstantSlippage(
      bar.close,
      exitSide,
      config.slippageBps,
    );

    const exitNotional = pos.quantity * fillPrice;
    const exitCommission = exitNotional * config.commissionRate;

    // Raw P&L from price movement
    const rawPnl =
      pos.side === "long"
        ? (fillPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - fillPrice) * pos.quantity;

    // Net P&L after both entry and exit commissions
    const netPnl = rawPnl - exitCommission;
    // Note: entry commission was already deducted from cash at entry

    wallet.cash += exitNotional - exitCommission;

    const totalCommission = pos.entryCommission + exitCommission;
    const pnlPct = ((rawPnl - exitCommission) / (pos.entryPrice * pos.quantity)) * 100;

    trades.push({
      entryTime: pos.entryTime,
      exitTime: bar.timestamp,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: fillPrice,
      quantity: pos.quantity,
      commission: totalCommission,
      slippage: slippageCost * pos.quantity,
      pnl: netPnl,
      pnlPct,
      reason: pos.reason,
      exitReason,
    });

    const idx = positions.indexOf(pos);
    if (idx !== -1) positions.splice(idx, 1);
  }

  /** Force-close all remaining open positions. */
  private closeAllPositions(
    positions: InternalPosition[],
    trades: TradeRecord[],
    lastBar: OHLCV,
    config: BacktestConfig,
    wallet: { cash: number },
  ): void {
    while (positions.length > 0) {
      this.closeSinglePosition(
        positions[0]!,
        lastBar,
        positions,
        trades,
        config,
        wallet,
        "end-of-backtest",
      );
    }
  }
}

/** Compute daily returns from an equity curve. */
function computeDailyReturns(equityCurve: number[]): number[] {
  if (equityCurve.length <= 1) return [];
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!;
    returns.push(prev === 0 ? 0 : (equityCurve[i]! - prev) / prev);
  }
  return returns;
}

function emptyResult(strategyId: string, capital: number): BacktestResult {
  return {
    strategyId,
    startDate: 0,
    endDate: 0,
    initialCapital: capital,
    finalEquity: capital,
    totalReturn: 0,
    sharpe: 0,
    sortino: 0,
    maxDrawdown: 0,
    calmar: 0,
    winRate: 0,
    profitFactor: 0,
    totalTrades: 0,
    trades: [],
    equityCurve: [capital],
    dailyReturns: [],
  };
}
