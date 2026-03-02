import type {
  DecayState,
  StrategyLevel,
  BacktestResult,
  WalkForwardResult,
} from "../../fin-shared-types/src/types.js";

/** Allocation entry: how much capital is assigned to a strategy. */
export interface Allocation {
  strategyId: string;
  capitalUsd: number;
  weightPct: number; // 0-100
  reason: string;
}

/** Fund-wide snapshot persisted to disk. */
export interface FundState {
  totalCapital: number;
  cashReserve: number;
  allocations: Allocation[];
  lastRebalanceAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Strategy data gathered from multiple services for ranking/allocation. */
export interface StrategyProfile {
  id: string;
  name: string;
  level: StrategyLevel;
  backtest?: BacktestResult;
  walkForward?: WalkForwardResult;
  paperMetrics?: DecayState;
  paperEquity?: number;
  paperInitialCapital?: number;
  paperDaysActive?: number;
  paperTradeCount?: number;
  fitness: number;
}

/** Leaderboard entry with confidence-adjusted score. */
export interface LeaderboardEntry {
  rank: number;
  strategyId: string;
  strategyName: string;
  level: StrategyLevel;
  fitness: number;
  confidenceMultiplier: number;
  leaderboardScore: number;
  sharpe: number;
  maxDrawdown: number;
  totalTrades: number;
}

/** Promotion check result. */
export interface PromotionCheck {
  strategyId: string;
  currentLevel: StrategyLevel;
  eligible: boolean;
  targetLevel?: StrategyLevel;
  reasons: string[];
  blockers: string[];
  needsUserConfirmation?: boolean;
}

/** Demotion check result. */
export interface DemotionCheck {
  strategyId: string;
  currentLevel: StrategyLevel;
  shouldDemote: boolean;
  targetLevel?: StrategyLevel;
  reasons: string[];
}

/** Fund risk status. */
export interface FundRiskStatus {
  totalEquity: number;
  todayPnl: number;
  todayPnlPct: number;
  dailyDrawdown: number;
  maxAllowedDrawdown: number;
  riskLevel: "normal" | "caution" | "warning" | "critical";
  activeStrategies: number;
  exposurePct: number;
  cashReservePct: number;
}

/** Correlation pair between two strategies. */
export interface CorrelationPair {
  strategyA: string;
  strategyB: string;
  correlation: number;
}

/** Fund configuration read from the app config. */
export interface FundConfig {
  totalCapital?: number;
  cashReservePct: number;
  maxSingleStrategyPct: number;
  maxTotalExposurePct: number;
  rebalanceFrequency: "daily" | "weekly" | "monthly";
}
