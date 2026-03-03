/**
 * Shared types used across fin-* extensions.
 *
 * This is the canonical source for types that appear in cross-extension
 * interfaces.  Individual extensions re-export these for backward
 * compatibility, but new cross-extension imports should reference
 * `@openfinclaw/fin-shared-types` (or relative path to this package).
 */

// ---------------------------------------------------------------------------
// Market data types (originally fin-data-bus)
// ---------------------------------------------------------------------------

export interface OHLCV {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketType = "crypto" | "equity" | "commodity";

export type MarketRegime = "bull" | "bear" | "sideways" | "volatile" | "crisis";

// ---------------------------------------------------------------------------
// Strategy engine types (originally fin-strategy-engine)
// ---------------------------------------------------------------------------

export type StrategyLevel = "L0_INCUBATE" | "L1_BACKTEST" | "L2_PAPER" | "L3_LIVE" | "KILLED";
export type StrategyStatus = "running" | "paused" | "stopped";

export interface Signal {
  action: "buy" | "sell" | "close";
  symbol: string;
  sizePct: number; // position size as % of equity (0-100)
  orderType: "market" | "limit";
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  reason: string;
  confidence: number; // 0-1
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
}

export interface IndicatorLib {
  sma(period: number): number[];
  ema(period: number): number[];
  rsi(period: number): number[];
  macd(
    fast?: number,
    slow?: number,
    signal?: number,
  ): { macd: number[]; signal: number[]; histogram: number[] };
  bollingerBands(
    period?: number,
    stdDev?: number,
  ): { upper: number[]; middle: number[]; lower: number[] };
  atr(period?: number): number[];
}

export interface StrategyContext {
  portfolio: { equity: number; cash: number; positions: Position[] };
  history: OHLCV[];
  indicators: IndicatorLib;
  regime: MarketRegime;
  memory: Map<string, unknown>;
  log(msg: string): void;
}

export interface StrategyDefinition {
  id: string;
  name: string;
  version: string;
  markets: MarketType[];
  symbols: string[];
  timeframes: string[];
  parameters: Record<string, number>;
  parameterRanges?: Record<string, { min: number; max: number; step: number }>;
  init?(ctx: StrategyContext): Promise<void>;
  onBar(bar: OHLCV, ctx: StrategyContext): Promise<Signal | null>;
  onDayEnd?(ctx: StrategyContext): Promise<void>;
}

export interface BacktestConfig {
  capital: number;
  commissionRate: number; // e.g., 0.001
  slippageBps: number; // e.g., 5
  market: MarketType;
}

export interface TradeRecord {
  entryTime: number;
  exitTime: number;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  commission: number;
  slippage: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  exitReason: string;
}

export interface BacktestResult {
  strategyId: string;
  startDate: number;
  endDate: number;
  initialCapital: number;
  finalEquity: number;
  totalReturn: number; // percentage
  sharpe: number;
  sortino: number;
  maxDrawdown: number; // negative percentage
  calmar: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  trades: TradeRecord[];
  equityCurve: number[]; // daily equity values
  dailyReturns: number[];
}

export interface WalkForwardResult {
  passed: boolean;
  windows: Array<{
    trainStart: number;
    trainEnd: number;
    testStart: number;
    testEnd: number;
    trainSharpe: number;
    testSharpe: number;
  }>;
  combinedTestSharpe: number;
  avgTrainSharpe: number;
  ratio: number; // combinedTest / avgTrain
  threshold: number; // 0.6
}

export interface StrategyRecord {
  id: string;
  name: string;
  version: string;
  level: StrategyLevel;
  status?: StrategyStatus;
  definition: StrategyDefinition;
  createdAt: number;
  updatedAt: number;
  lastBacktest?: BacktestResult;
  lastWalkForward?: WalkForwardResult;
}

// ---------------------------------------------------------------------------
// Paper trading types (originally fin-paper-trading)
// ---------------------------------------------------------------------------

export interface DecayState {
  rollingSharpe7d: number;
  rollingSharpe30d: number;
  sharpeMomentum: number;
  consecutiveLossDays: number;
  currentDrawdown: number;
  peakEquity: number;
  decayLevel: "healthy" | "warning" | "degrading" | "critical";
}

// ---------------------------------------------------------------------------
// Fitness types (originally fin-strategy-engine/fitness.ts)
// ---------------------------------------------------------------------------

export interface FitnessInput {
  longTerm: { sharpe: number; maxDD: number; trades: number };
  recent: { sharpe: number; maxDD: number; trades: number };
  paper?: { sharpe: number; maxDD: number; trades: number };
  correlationWithPortfolio?: number; // 0-1
  daysSinceLaunch?: number;
}

// ---------------------------------------------------------------------------
// Fill simulation types (originally fin-paper-trading/fill-simulation)
// ---------------------------------------------------------------------------

export interface FillResult {
  fillPrice: number;
  slippageCost: number;
}
