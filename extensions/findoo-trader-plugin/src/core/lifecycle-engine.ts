/**
 * Autonomous Strategy Lifecycle Engine.
 *
 * The single source of truth for strategy level transitions (except ColdStartSeeder's L0→L1).
 * Runs on a timer (default 5 min), scanning all strategies and executing promotions/demotions.
 *
 * Design invariant: L2→L3 ALWAYS requires user approval (real money = human confirmation).
 */

import type { ActivityLogStore } from "./activity-log-store.js";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import type { AgentWakeBridge } from "./agent-wake-bridge.js";

// ── Dependency interfaces (duck-typed to avoid circular imports) ─────

type StrategyRegistryLike = {
  list(filter?: { level?: string }): Array<{
    id: string;
    name: string;
    level: string;
    definition: { symbols: string[]; timeframes: string[]; markets: string[] };
    lastBacktest?: { sharpe: number; maxDrawdown: number; totalTrades: number };
    lastWalkForward?: { passed: boolean; ratio: number; threshold: number };
  }>;
  updateLevel(id: string, level: string): void;
};

type FundManagerLike = {
  buildProfiles(
    records: unknown[],
    paperData?: Map<string, unknown>,
  ): Array<{
    id: string;
    name: string;
    level: string;
    backtest?: { sharpe: number; maxDrawdown: number; totalTrades: number };
    walkForward?: { passed: boolean; ratio: number; threshold: number };
    paperMetrics?: {
      rollingSharpe7d: number;
      rollingSharpe30d: number;
      currentDrawdown: number;
      consecutiveLossDays: number;
      decayLevel: string;
    };
    paperEquity?: number;
    paperInitialCapital?: number;
    paperDaysActive?: number;
    paperTradeCount?: number;
    fitness: number;
  }>;
  checkPromotion(profile: unknown): {
    strategyId: string;
    currentLevel: string;
    eligible: boolean;
    targetLevel?: string;
    needsUserConfirmation?: boolean;
    reasons: string[];
    blockers: string[];
  };
  checkDemotion(profile: unknown): {
    strategyId: string;
    currentLevel: string;
    shouldDemote: boolean;
    targetLevel?: string;
    reasons: string[];
  };
};

type PaperEngineLike = {
  listAccounts(): Array<{ id: string; name: string; equity: number }>;
  getAccountState(id: string): { equity: number; positions: Array<Record<string, unknown>> } | null;
  getSnapshots?(
    id: string,
  ): Array<{ timestamp: number; equity: number; dailyPnl: number; dailyPnlPct: number }>;
};

// ── Engine ────────────────────────────────────────────────────────────

export type LifecycleEngineDeps = {
  strategyRegistry: StrategyRegistryLike;
  fundManagerResolver: () => FundManagerLike | undefined;
  paperEngine: PaperEngineLike;
  eventStore: AgentEventSqliteStore;
  activityLog: ActivityLogStore;
  wakeBridge: AgentWakeBridge;
};

export type LifecycleEngineStats = {
  running: boolean;
  cycleCount: number;
  lastCycleAt: number;
  promotionCount: number;
  demotionCount: number;
  pendingApprovals: number;
};

export class LifecycleEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycleCount = 0;
  private lastCycleAt = 0;
  private promotionCount = 0;
  private demotionCount = 0;
  private pendingApprovals = new Set<string>(); // strategyIds awaiting approval
  private readonly deps: LifecycleEngineDeps;
  private readonly intervalMs: number;

  constructor(deps: LifecycleEngineDeps, intervalMs = 5 * 60_000) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  // ── Control ─────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runCycle(), this.intervalMs);
    this.deps.activityLog.append({
      category: "heartbeat",
      action: "lifecycle_engine_started",
      detail: `Lifecycle engine started (interval=${Math.round(this.intervalMs / 1000)}s)`,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStats(): LifecycleEngineStats {
    return {
      running: this.timer !== null,
      cycleCount: this.cycleCount,
      lastCycleAt: this.lastCycleAt,
      promotionCount: this.promotionCount,
      demotionCount: this.demotionCount,
      pendingApprovals: this.pendingApprovals.size,
    };
  }

  // ── Core Cycle ──────────────────────────────────────────────────

  /**
   * Main lifecycle scan. Called every 5 min by timer.
   * 1. L1 backtest-complete → auto-promote to L2
   * 2. L2 paper-eligible → send approval event (never auto-promote to L3)
   * 3. L2/L3 degraded → auto-demote
   */
  async runCycle(): Promise<{
    promoted: number;
    approvalsSent: number;
    demoted: number;
    errors: number;
  }> {
    const { strategyRegistry, fundManagerResolver, activityLog } = this.deps;
    const fundManager = fundManagerResolver();

    let promoted = 0;
    let approvalsSent = 0;
    let demoted = 0;
    let errors = 0;

    if (!fundManager) {
      this.cycleCount++;
      this.lastCycleAt = Date.now();
      return { promoted, approvalsSent, demoted, errors };
    }

    try {
      const allRecords = strategyRegistry.list();
      const profiles = fundManager.buildProfiles(allRecords);

      // ── 1. Check promotions ─────────────────────────────────
      for (const profile of profiles) {
        try {
          const check = fundManager.checkPromotion(profile);
          if (!check.eligible || !check.targetLevel) continue;

          if (check.needsUserConfirmation) {
            // L2→L3: require user approval
            if (!this.pendingApprovals.has(profile.id)) {
              this.sendApprovalRequest(profile.id, profile.name, check);
              approvalsSent++;
            }
          } else {
            // L1→L2 (or L0→L1): auto-promote
            this.executePromotion(
              profile.id,
              profile.name,
              check.currentLevel,
              check.targetLevel,
              check.reasons,
            );
            promoted++;
          }
        } catch {
          errors++;
        }
      }

      // ── 2. Check demotions ──────────────────────────────────
      for (const profile of profiles) {
        try {
          const check = fundManager.checkDemotion(profile);
          if (!check.shouldDemote || !check.targetLevel) continue;

          this.executeDemotion(
            profile.id,
            profile.name,
            check.currentLevel,
            check.targetLevel,
            check.reasons,
          );
          demoted++;
        } catch {
          errors++;
        }
      }
    } catch (err) {
      errors++;
      activityLog.append({
        category: "error",
        action: "lifecycle_cycle_error",
        detail: `Cycle error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    this.cycleCount++;
    this.lastCycleAt = Date.now();

    if (promoted > 0 || approvalsSent > 0 || demoted > 0) {
      activityLog.append({
        category: "heartbeat",
        action: "lifecycle_cycle_summary",
        detail: `Cycle #${this.cycleCount}: promoted=${promoted} approvals=${approvalsSent} demoted=${demoted} errors=${errors}`,
        metadata: { promoted, approvalsSent, demoted, errors },
      });
    }

    return { promoted, approvalsSent, demoted, errors };
  }

  // ── Approval Handling ───────────────────────────────────────────

  /** User approved L2→L3 promotion. Execute the level change. */
  handleApproval(strategyId: string): boolean {
    const { strategyRegistry, activityLog } = this.deps;
    const record = strategyRegistry.list().find((r) => r.id === strategyId);
    if (!record || record.level !== "L2_PAPER") return false;

    strategyRegistry.updateLevel(strategyId, "L3_LIVE");
    this.pendingApprovals.delete(strategyId);
    this.promotionCount++;

    activityLog.append({
      category: "approval",
      action: "l3_promotion_approved",
      strategyId,
      detail: `User approved L2→L3 promotion for "${record.name}"`,
      metadata: { from: "L2_PAPER", to: "L3_LIVE" },
    });

    // Notify agent
    this.deps.wakeBridge.onPromotionReady({
      strategyId,
      from: "L2_PAPER",
      to: "L3_LIVE",
    });

    return true;
  }

  /** User rejected L2→L3 promotion. */
  handleRejection(strategyId: string, reason?: string): boolean {
    if (!this.pendingApprovals.has(strategyId)) return false;
    this.pendingApprovals.delete(strategyId);

    this.deps.activityLog.append({
      category: "approval",
      action: "l3_promotion_rejected",
      strategyId,
      detail: `User rejected L2→L3 promotion${reason ? `: ${reason}` : ""}`,
      metadata: { reason },
    });

    return true;
  }

  // ── Internal Execution ──────────────────────────────────────────

  private executePromotion(
    strategyId: string,
    name: string,
    from: string,
    to: string,
    reasons: string[],
  ): void {
    const { strategyRegistry, activityLog, wakeBridge } = this.deps;

    strategyRegistry.updateLevel(strategyId, to);
    this.promotionCount++;

    activityLog.append({
      category: "promotion",
      action: `promote_${from}_to_${to}`.toLowerCase(),
      strategyId,
      detail: `Auto-promoted "${name}" ${from}→${to}: ${reasons.join("; ")}`,
      metadata: { from, to, reasons },
    });

    wakeBridge.onPromotionReady({ strategyId, from, to });
  }

  private executeDemotion(
    strategyId: string,
    name: string,
    from: string,
    to: string,
    reasons: string[],
  ): void {
    const { strategyRegistry, activityLog } = this.deps;

    strategyRegistry.updateLevel(strategyId, to);
    this.demotionCount++;

    activityLog.append({
      category: "demotion",
      action: `demote_${from}_to_${to}`.toLowerCase(),
      strategyId,
      detail: `Demoted "${name}" ${from}→${to}: ${reasons.join("; ")}`,
      metadata: { from, to, reasons },
    });
  }

  private sendApprovalRequest(
    strategyId: string,
    name: string,
    check: { targetLevel?: string; reasons: string[] },
  ): void {
    const { eventStore, activityLog, wakeBridge } = this.deps;

    this.pendingApprovals.add(strategyId);

    // Add to event store for dashboard + Telegram approval
    eventStore.addEvent({
      type: "trade_pending",
      title: `L3 Promotion: ${name}`,
      detail: `Strategy "${name}" is eligible for live trading. Reasons: ${check.reasons.join("; ")}`,
      status: "pending",
      actionParams: {
        action: "promote_l3",
        strategyId,
        targetLevel: check.targetLevel,
      },
    });

    activityLog.append({
      category: "approval",
      action: "l3_approval_requested",
      strategyId,
      detail: `Requesting user approval for "${name}" L2→L3: ${check.reasons.join("; ")}`,
      metadata: { reasons: check.reasons },
    });

    wakeBridge.onApprovalNeeded({ strategyId, strategyName: name });
  }
}
