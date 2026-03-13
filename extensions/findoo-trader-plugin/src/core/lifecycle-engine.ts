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
  getAccountState(id: string): {
    equity: number;
    initialCapital: number;
    createdAt: number;
    positions: Array<Record<string, unknown>>;
    orders: Array<Record<string, unknown>>;
  } | null;
  getMetrics?(id: string): {
    rollingSharpe7d: number;
    rollingSharpe30d: number;
    currentDrawdown: number;
    consecutiveLossDays: number;
    decayLevel: string;
  } | null;
  getSnapshots?(
    id: string,
  ): Array<{ timestamp: number; equity: number; dailyPnl: number; dailyPnlPct: number }>;
};

// ── Paper Data Gathering (shared with fund/tools.ts) ─────────────────

/** Gather per-strategy paper trading data from the paper engine. */
export function gatherPaperData(paperEngine: PaperEngineLike): Map<
  string,
  {
    metrics?: {
      rollingSharpe7d: number;
      rollingSharpe30d: number;
      currentDrawdown: number;
      consecutiveLossDays: number;
      decayLevel: string;
    };
    equity?: number;
    initialCapital?: number;
    daysActive?: number;
    tradeCount?: number;
  }
> {
  const data = new Map<
    string,
    {
      metrics?: {
        rollingSharpe7d: number;
        rollingSharpe30d: number;
        currentDrawdown: number;
        consecutiveLossDays: number;
        decayLevel: string;
      };
      equity?: number;
      initialCapital?: number;
      daysActive?: number;
      tradeCount?: number;
    }
  >();

  const accounts = paperEngine.listAccounts();
  for (const acct of accounts) {
    const state = paperEngine.getAccountState(acct.id);
    if (!state) continue;
    const metrics = paperEngine.getMetrics?.(acct.id) ?? undefined;
    const orders = state.orders ?? [];
    // Extract strategyIds from orders (not positions — orders carry strategyId)
    const strategyIds = new Set<string>();
    for (const order of orders) {
      const sid = order.strategyId as string | undefined;
      if (sid) strategyIds.add(sid);
    }
    for (const sid of strategyIds) {
      data.set(sid, {
        metrics: metrics ?? undefined,
        equity: state.equity,
        initialCapital: state.initialCapital,
        daysActive: Math.floor((Date.now() - state.createdAt) / 86_400_000),
        tradeCount: orders.filter((o) => o.strategyId === sid).length,
      });
    }
  }

  return data;
}

// ── Engine ────────────────────────────────────────────────────────────

type LiveHealthMonitorLike = {
  check(): Promise<{ circuitBroken: boolean; lossPct: number; strategiesAffected: string[] }>;
};

type LiveReconcilerLike = {
  reconcile(): Promise<Array<{ strategyId: string; driftPct: number; severity: string }>>;
  getConsecutiveCritical(strategyId: string): number;
};

type AlertEngineLike = {
  getActiveAlerts(): Array<{
    id: string;
    condition: { kind: string; symbol?: string; price?: number };
  }>;
  checkAndTrigger(getPrice: (symbol: string) => number | undefined): string[];
  acknowledgeAlert?(id: string): boolean;
  getUnacknowledged?(maxRetries?: number): Array<{
    id: string;
    condition: { kind: string; symbol?: string; price?: number };
    message: string | null;
    retryCount: number;
  }>;
  incrementRetry?(id: string): void;
};

type DataProviderLike = {
  getTicker(symbol: string, market: string): Promise<{ close?: number } | null>;
};

type ExchangeRegistryLike = {
  listExchanges(): Array<{ id: string; exchange: string }>;
  getInstance(id: string): Promise<unknown>;
};

type ExchangeHealthStoreLike = {
  recordPing(exchangeId: string, latencyMs: number): void;
  recordError(exchangeId: string, message: string): void;
};

export type LifecycleEngineDeps = {
  strategyRegistry: StrategyRegistryLike;
  fundManagerResolver: () => FundManagerLike | undefined;
  paperEngine: PaperEngineLike;
  eventStore: AgentEventSqliteStore;
  activityLog: ActivityLogStore;
  wakeBridge: AgentWakeBridge;
  /** Optional L3 live health monitor — circuit breaker for cumulative loss. */
  liveHealthMonitor?: LiveHealthMonitorLike;
  /** Optional L3 live reconciler — detects drift between live and paper positions. */
  liveReconciler?: LiveReconcilerLike;
  /** Optional alert engine — auto-triggers price alerts each cycle. */
  alertEngine?: AlertEngineLike;
  /** Optional data provider — fetches current prices for alert checks. */
  dataProvider?: DataProviderLike;
  /** Optional exchange registry + health store — for auto-reconnect health pings. */
  exchangeRegistry?: ExchangeRegistryLike;
  exchangeHealthStore?: ExchangeHealthStoreLike;
  /** Optional garbage collector — kills strategies meeting multi-rule criteria. */
  garbageCollector?: {
    collect(
      profiles: Array<{
        id: string;
        level: string;
        paperMetrics?: { rollingSharpe7d: number; consecutiveLossDays: number };
        paperDaysActive?: number;
        paperTradeCount?: number;
      }>,
    ): { killed: string[]; reasons: Map<string, string> };
  };
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
    const { strategyRegistry, fundManagerResolver, paperEngine, activityLog } = this.deps;
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

    let profiles: ReturnType<FundManagerLike["buildProfiles"]> = [];

    try {
      const allRecords = strategyRegistry.list();
      const paperData = gatherPaperData(paperEngine);
      profiles = fundManager.buildProfiles(allRecords, paperData);

      // ── 1. Check promotions — recommend to Agent, don't auto-execute ──
      const promoRecommendations: Array<{
        strategyId: string;
        name: string;
        from: string;
        to: string;
        reasons: string[];
      }> = [];

      for (const profile of profiles) {
        try {
          const check = fundManager.checkPromotion(profile);
          if (!check.eligible || !check.targetLevel) continue;

          if (check.needsUserConfirmation) {
            // L2→L3: still require user approval (unchanged)
            if (!this.pendingApprovals.has(profile.id)) {
              this.sendApprovalRequest(profile.id, profile.name, check);
              approvalsSent++;
            }
          } else {
            // L0→L1, L1→L2: recommend to Agent instead of auto-executing
            promoRecommendations.push({
              strategyId: profile.id,
              name: profile.name,
              from: check.currentLevel,
              to: check.targetLevel,
              reasons: check.reasons,
            });
            promoted++;
          }
        } catch {
          errors++;
        }
      }

      // ── 2. Check demotions — recommend to Agent ──
      const demoRecommendations: Array<{
        strategyId: string;
        name: string;
        from: string;
        to: string;
        reasons: string[];
      }> = [];

      for (const profile of profiles) {
        try {
          const check = fundManager.checkDemotion(profile);
          if (!check.shouldDemote || !check.targetLevel) continue;

          demoRecommendations.push({
            strategyId: profile.id,
            name: profile.name,
            from: check.currentLevel,
            to: check.targetLevel,
            reasons: check.reasons,
          });
          demoted++;
        } catch {
          errors++;
        }
      }

      // Notify Agent of all recommended actions (Agent decides whether to execute)
      if (promoRecommendations.length > 0 || demoRecommendations.length > 0) {
        this.deps.wakeBridge.onLifecycleRecommendation({
          promotions: promoRecommendations,
          demotions: demoRecommendations,
        });
      }
    } catch (err) {
      errors++;
      activityLog.append({
        category: "error",
        action: "lifecycle_cycle_error",
        detail: `Cycle error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // ── 2b. Garbage collection (optional Alpha Factory integration) ──
    try {
      if (this.deps.garbageCollector && profiles.length > 0) {
        const gcResult = this.deps.garbageCollector.collect(
          profiles as Parameters<
            NonNullable<LifecycleEngineDeps["garbageCollector"]>["collect"]
          >[0],
        );
        for (const sid of gcResult.killed) {
          const rec = strategyRegistry.list().find((r) => r.id === sid);
          if (rec && rec.level !== "KILLED") {
            this.executeDemotion(sid, rec.name, rec.level, "KILLED", [
              gcResult.reasons.get(sid) ?? "GC rule triggered",
            ]);
            demoted++;
          }
        }
      }
    } catch {
      errors++;
    }

    // ── 3. L3 Live Health Monitor — circuit breaker ──
    try {
      const healthResult = await this.deps.liveHealthMonitor?.check();
      if (healthResult?.circuitBroken) {
        for (const sid of healthResult.strategiesAffected) {
          const rec = strategyRegistry.list().find((r) => r.id === sid);
          if (rec && rec.level === "L3_LIVE") {
            this.executeDemotion(sid, rec.name, "L3_LIVE", "L2_PAPER", [
              `Circuit breaker: ${healthResult.lossPct.toFixed(1)}% cumulative loss`,
            ]);
            demoted++;
          }
        }
      }
    } catch {
      errors++;
    }

    // ── 4. L3 Live Reconciler — position drift detection ──
    try {
      const drifts = await this.deps.liveReconciler?.reconcile();
      if (drifts) {
        for (const d of drifts) {
          if (
            d.severity === "critical" &&
            (this.deps.liveReconciler?.getConsecutiveCritical(d.strategyId) ?? 0) >= 2
          ) {
            const rec = strategyRegistry.list().find((r) => r.id === d.strategyId);
            if (rec && rec.level === "L3_LIVE") {
              this.executeDemotion(d.strategyId, rec.name, "L3_LIVE", "L2_PAPER", [
                `Position drift ${d.driftPct.toFixed(1)}% (critical for 2+ cycles)`,
              ]);
              demoted++;
            }
          }
        }
      }
    } catch {
      errors++;
    }

    // Reconcile pending wake events — conditions that cleared since last cycle
    try {
      this.deps.wakeBridge.reconcilePending?.();
    } catch {
      // non-critical
    }

    // Drain undelivered wakes (retry any that failed to enqueue)
    try {
      this.deps.wakeBridge.drainUndelivered?.();
    } catch {
      // non-critical
    }

    // ── 5. Alert auto-trigger — check price alerts each cycle ──
    try {
      if (this.deps.alertEngine && this.deps.dataProvider) {
        const alerts = this.deps.alertEngine.getActiveAlerts();
        if (alerts.length > 0) {
          const symbols = [
            ...new Set(alerts.map((a) => a.condition.symbol).filter(Boolean)),
          ] as string[];
          const priceCache = new Map<string, number>();

          for (const sym of symbols) {
            try {
              const ticker = await this.deps.dataProvider.getTicker(sym, "crypto");
              if (ticker?.close) priceCache.set(sym, ticker.close);
            } catch {
              /* skip unavailable symbols */
            }
          }

          const triggered = this.deps.alertEngine.checkAndTrigger((s) => priceCache.get(s));
          for (const alertId of triggered) {
            try {
              this.deps.wakeBridge.onHealthAlert({
                accountId: "alert",
                condition: `alert_triggered:${alertId}`,
                value: 0,
              });
              // Acknowledge on successful delivery
              this.deps.alertEngine.acknowledgeAlert?.(alertId);
            } catch {
              // Delivery failed — will be retried via unacknowledged loop below
            }
          }
        }

        // ── 5b. Retry unacknowledged alerts (max 5 retries per alert) ──
        const unacked = this.deps.alertEngine.getUnacknowledged?.(5) ?? [];
        for (const alert of unacked) {
          try {
            this.deps.wakeBridge.onHealthAlert({
              accountId: "alert",
              condition: `alert_retry:${alert.id}`,
              value: alert.retryCount,
            });
            this.deps.alertEngine.acknowledgeAlert?.(alert.id);
          } catch {
            this.deps.alertEngine.incrementRetry?.(alert.id);
          }
        }
      }
    } catch {
      // non-critical
    }

    // ── 6. Exchange health ping — probe all configured exchanges ──
    try {
      if (this.deps.exchangeRegistry && this.deps.exchangeHealthStore) {
        const exchanges = this.deps.exchangeRegistry.listExchanges();
        for (const ex of exchanges) {
          const start = Date.now();
          try {
            const instance = await this.deps.exchangeRegistry.getInstance(ex.id);
            // Use fetchTicker as a lightweight health probe
            if (
              instance &&
              typeof (instance as Record<string, unknown>).fetchTicker === "function"
            ) {
              await (instance as { fetchTicker: (s: string) => Promise<unknown> }).fetchTicker(
                "BTC/USDT",
              );
            }
            this.deps.exchangeHealthStore.recordPing(ex.id, Date.now() - start);
          } catch (err) {
            this.deps.exchangeHealthStore.recordError(
              ex.id,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    } catch {
      // non-critical
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
      narration: `我检测到「${name}」的模拟盘表现已达到实盘标准。${check.reasons.join("；")}。建议批准上线，我会严格执行风控。`,
      feedType: "appr",
      chips: check.reasons.slice(0, 4).map((r) => {
        const kv = r.split(/[:=]\s*/);
        return { label: kv[0] ?? r, value: kv[1] ?? "OK" };
      }),
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
