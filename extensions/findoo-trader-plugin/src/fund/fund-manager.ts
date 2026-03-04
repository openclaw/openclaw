import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecayState, FitnessInput, StrategyRecord, StrategyLevel } from "../shared/types.js";
import { calculateFitness } from "../strategy/fitness.js";
import { CapitalAllocator } from "./capital-allocator.js";
import { CorrelationMonitor, pearsonCorrelation } from "./correlation-monitor.js";
import { FundRiskManager } from "./fund-risk-manager.js";
import { Leaderboard } from "./leaderboard.js";
import { PromotionPipeline } from "./promotion-pipeline.js";
import type {
  Allocation,
  FundConfig,
  FundRiskStatus,
  FundState,
  LeaderboardEntry,
  PromotionCheck,
  DemotionCheck,
  StrategyProfile,
  CorrelationPair,
} from "./types.js";

/**
 * Fund Manager — orchestrates capital allocation, risk control,
 * strategy ranking, and promotion/demotion across the full pipeline.
 */
export class FundManager {
  readonly allocator: CapitalAllocator;
  readonly correlationMonitor: CorrelationMonitor;
  readonly riskManager: FundRiskManager;
  readonly leaderboard: Leaderboard;
  readonly promotionPipeline: PromotionPipeline;

  private state: FundState;
  private config: FundConfig;
  private filePath: string;

  constructor(filePath: string, config: FundConfig) {
    this.filePath = filePath;
    this.config = config;
    this.allocator = new CapitalAllocator();
    this.correlationMonitor = new CorrelationMonitor();
    this.riskManager = new FundRiskManager(config);
    this.leaderboard = new Leaderboard();
    this.promotionPipeline = new PromotionPipeline();
    this.state = this.load();
  }

  /** Get current fund state. */
  getState(): FundState {
    return { ...this.state };
  }

  /** Get fund configuration. */
  getConfig(): FundConfig {
    return { ...this.config };
  }

  /**
   * Build strategy profiles from registry records and paper trading data.
   * This bridges the strategy-engine and paper-trading services.
   */
  buildProfiles(
    records: StrategyRecord[],
    paperData?: Map<
      string,
      {
        metrics?: DecayState;
        equity?: number;
        initialCapital?: number;
        daysActive?: number;
        tradeCount?: number;
      }
    >,
  ): StrategyProfile[] {
    return records
      .filter((r) => r.level !== "KILLED")
      .map((r) => {
        const paper = paperData?.get(r.id);

        // Fitness expects maxDD as decimal fraction (e.g. -0.12), but
        // BacktestResult stores it as negative percentage (e.g. -12).
        const btMaxDD = (r.lastBacktest?.maxDrawdown ?? 0) / 100;
        const paperMaxDD = (paper?.metrics?.currentDrawdown ?? 0) / 100;

        const fitnessInput: FitnessInput = {
          longTerm: {
            sharpe: r.lastBacktest?.sharpe ?? 0,
            maxDD: btMaxDD,
            trades: r.lastBacktest?.totalTrades ?? 0,
          },
          recent: {
            sharpe: r.lastBacktest?.sharpe ?? 0,
            maxDD: btMaxDD,
            trades: r.lastBacktest?.totalTrades ?? 0,
          },
          paper: paper?.metrics
            ? {
                sharpe: paper.metrics.rollingSharpe30d,
                maxDD: paperMaxDD,
                trades: paper.tradeCount ?? 0,
              }
            : undefined,
          daysSinceLaunch: Math.floor((Date.now() - r.createdAt) / 86_400_000),
        };

        return {
          id: r.id,
          name: r.name,
          level: r.level,
          backtest: r.lastBacktest,
          walkForward: r.lastWalkForward,
          paperMetrics: paper?.metrics,
          paperEquity: paper?.equity,
          paperInitialCapital: paper?.initialCapital,
          paperDaysActive: paper?.daysActive,
          paperTradeCount: paper?.tradeCount,
          fitness: calculateFitness(fitnessInput),
        };
      });
  }

  /** Allocate capital across eligible strategies. */
  allocate(
    profiles: StrategyProfile[],
    correlations?: Map<string, Map<string, number>>,
  ): Allocation[] {
    const totalCapital = this.config.totalCapital ?? this.state.totalCapital;
    const allocations = this.allocator.allocate(profiles, totalCapital, this.config, correlations);

    this.state.allocations = allocations;
    this.state.lastRebalanceAt = Date.now();
    this.state.updatedAt = Date.now();
    this.save();

    return allocations;
  }

  /** Generate leaderboard. */
  getLeaderboard(profiles: StrategyProfile[]): LeaderboardEntry[] {
    return this.leaderboard.rank(profiles);
  }

  /** Check promotion eligibility for a strategy. */
  checkPromotion(profile: StrategyProfile): PromotionCheck {
    return this.promotionPipeline.checkPromotion(profile);
  }

  /** Check if a strategy should be demoted. */
  checkDemotion(profile: StrategyProfile): DemotionCheck {
    return this.promotionPipeline.checkDemotion(profile);
  }

  /** Evaluate fund-level risk. */
  evaluateRisk(currentEquity: number): FundRiskStatus {
    return this.riskManager.evaluate(currentEquity, this.state.allocations);
  }

  /** Mark day start for risk tracking. */
  markDayStart(equity: number): void {
    this.riskManager.markDayStart(equity);
  }

  /** Update total capital. */
  setTotalCapital(capital: number): void {
    this.state.totalCapital = capital;
    this.state.updatedAt = Date.now();
    this.save();
  }

  /** Compute correlations from equity curves. */
  computeCorrelations(curves: Map<string, number[]>): {
    matrix: Map<string, Map<string, number>>;
    highCorrelation: CorrelationPair[];
  } {
    return this.correlationMonitor.compute(curves);
  }

  /** Run a full rebalance cycle: profile → correlate → allocate → risk check. */
  rebalance(
    records: StrategyRecord[],
    paperData?: Map<
      string,
      {
        metrics?: DecayState;
        equity?: number;
        initialCapital?: number;
        daysActive?: number;
        tradeCount?: number;
      }
    >,
    equityCurves?: Map<string, number[]>,
  ): {
    allocations: Allocation[];
    leaderboard: LeaderboardEntry[];
    risk: FundRiskStatus;
    promotions: PromotionCheck[];
    demotions: DemotionCheck[];
  } {
    const profiles = this.buildProfiles(records, paperData);

    // Correlations
    let correlations: Map<string, Map<string, number>> | undefined;
    if (equityCurves && equityCurves.size > 1) {
      const result = this.correlationMonitor.compute(equityCurves);
      correlations = result.matrix;
    }

    // Allocate
    const allocations = this.allocate(profiles, correlations);

    // Leaderboard
    const lb = this.leaderboard.rank(profiles);

    // Risk
    const totalEquity = this.config.totalCapital ?? this.state.totalCapital;
    const risk = this.riskManager.evaluate(totalEquity, allocations);

    // Promotion/demotion checks
    const promotions: PromotionCheck[] = [];
    const demotions: DemotionCheck[] = [];
    for (const profile of profiles) {
      const promo = this.promotionPipeline.checkPromotion(profile);
      if (promo.eligible) promotions.push(promo);

      const demo = this.promotionPipeline.checkDemotion(profile);
      if (demo.shouldDemote) demotions.push(demo);
    }

    return { allocations, leaderboard: lb, risk, promotions, demotions };
  }

  /** Persist fund state to disk. */
  save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  /** Load fund state from disk. */
  private load(): FundState {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw) as FundState;
      } catch {
        // Corrupted — start fresh
      }
    }

    const now = Date.now();
    return {
      totalCapital: this.config.totalCapital ?? 100000,
      cashReserve: 0,
      allocations: [],
      lastRebalanceAt: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
}
