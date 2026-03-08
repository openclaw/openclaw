import type { MarketRegime } from "../shared/types.js";

export interface MonteCarloResult {
  pValue: number;
  trials: number;
  originalSharpe: number;
  permutedMean: number;
  permutedP95: number;
  passed: boolean; // p < 0.05
}

export interface RegimeSplitResult {
  regimeResults: Array<{ regime: MarketRegime; sharpe: number; trades: number }>;
  passedRegimes: number;
  totalRegimes: number;
  passed: boolean; // >= 3/5
}

export interface CostSensitivityResult {
  results: Array<{ multiplier: number; sharpe: number; netReturn: number }>;
  sharpeAt3x: number;
  passed: boolean; // Sharpe > 0.5 at 3x
}

export interface IndependenceResult {
  maxCorrelation: number;
  mostCorrelatedWith?: string;
  marginalSharpe: number;
  passed: boolean; // corr < 0.5 && marginal > 0.05
}

export interface DecayEstimate {
  halfLifeDays: number;
  decayRate: number; // lambda
  r2: number;
  classification: "stable" | "slow-decay" | "fast-decay";
}

export interface ScreeningResult {
  strategyId: string;
  passed: boolean;
  quickBacktest: { sharpe: number; maxDD: number; trades: number };
  perturbationStability: number;
  failReason?: string;
}

export interface ValidationResult {
  strategyId: string;
  passed: boolean;
  monteCarlo?: MonteCarloResult;
  regimeSplit?: RegimeSplitResult;
  costSensitivity?: CostSensitivityResult;
  independence?: IndependenceResult;
  failedAt?: string;
}

export interface GCResult {
  killed: string[];
  reasons: Map<string, string>;
}

export interface ScaleInState {
  phase: 1 | 2 | 3;
  phaseStartDate: number;
  capitalPct: number;
  phaseSharpe: number;
}

export interface CapacityEstimate {
  maxCapitalUsd: number;
  impactCostBps: number;
  avgDailyVolume: number;
  participationRate: number;
}

export interface FailurePattern {
  templateId: string;
  symbol: string;
  failStage: "screening" | "validation" | "paper" | "gc";
  failReason: string;
  parameters: Record<string, number>;
  timestamp: number;
}

export interface FactoryStats {
  running: boolean;
  ideationCount: number;
  screeningPassed: number;
  screeningFailed: number;
  validationPassed: number;
  validationFailed: number;
  gcKilled: number;
  evolutionCycles: number;
  lastCycleAt: number;
}
