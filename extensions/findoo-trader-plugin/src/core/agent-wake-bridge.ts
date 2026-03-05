/**
 * Agent Wake Bridge — bridges findoo-trader-plugin internal events to the
 * OpenClaw heartbeat system event queue.
 *
 * When HealthMonitor detects an alert, DailyBrief completes, ColdStartSeeder
 * finishes backtests, or a strategy reaches promotion eligibility, this bridge
 * calls enqueueSystemEvent() to wake the heartbeat runner so the LLM agent
 * can autonomously respond.
 */

import type { ActivityLogStore } from "./activity-log-store.js";

type EnqueueFn = (text: string, options: { sessionKey: string; contextKey?: string }) => void;

export interface AgentWakeBridgeConfig {
  enqueueSystemEvent: EnqueueFn;
  /** Resolves the active heartbeat session key at call time. */
  sessionKeyResolver: () => string | undefined;
  /** Optional activity log — every wake event is recorded for the Flow timeline. */
  activityLog?: ActivityLogStore;
}

export interface PendingWake {
  wakeId: string;
  firedAt: number;
  contextKey: string;
}

export class AgentWakeBridge {
  private enqueue: EnqueueFn;
  private resolveSessionKey: () => string | undefined;
  private activityLog?: ActivityLogStore;
  private pendingWakes = new Map<string, PendingWake>();
  /** contextKeys fired during the current cycle (reset each reconcile). */
  private currentCycleFired = new Set<string>();
  private wakeCounter = 0;

  constructor(config: AgentWakeBridgeConfig) {
    this.enqueue = config.enqueueSystemEvent;
    this.resolveSessionKey = config.sessionKeyResolver;
    this.activityLog = config.activityLog;
  }

  /** Returns pending (unresolved) wake entries. */
  getPending(): PendingWake[] {
    return [...this.pendingWakes.values()];
  }

  /**
   * Reconcile pending wakes: any contextKey that was NOT re-fired this cycle
   * is considered resolved (the underlying condition has cleared).
   */
  reconcilePending(): number {
    let resolved = 0;
    for (const [key, wake] of this.pendingWakes) {
      if (!this.currentCycleFired.has(key)) {
        this.pendingWakes.delete(key);
        resolved++;
        this.activityLog?.append({
          category: "wake",
          action: "wake_resolved",
          detail: `Wake resolved: ${wake.contextKey} (fired at ${new Date(wake.firedAt).toISOString()})`,
          metadata: { wakeId: wake.wakeId, contextKey: wake.contextKey },
        });
      }
    }
    this.currentCycleFired.clear();
    return resolved;
  }

  /** Health alert detected (DD, consecutive loss, low Sharpe). */
  onHealthAlert(alert: { accountId: string; condition: string; value: number }): void {
    this.activityLog?.append({
      category: "wake",
      action: "health_alert_wake",
      detail: `Health alert: ${alert.condition} on ${alert.accountId} (${alert.value.toFixed(2)})`,
      metadata: { accountId: alert.accountId, condition: alert.condition, value: alert.value },
    });
    this.wake(
      `[findoo-trader] Health alert: ${alert.condition} on account ${alert.accountId} (value: ${alert.value.toFixed(2)}). ` +
        `Use fin_fund_status and fin_fund_risk to assess, then decide on demotion or position reduction.`,
      `cron:findoo:health:${alert.accountId}:${alert.condition}`,
    );
  }

  /** Daily brief generated — wake Agent to deliver summary. */
  onDailyBriefReady(brief: { totalPnl: number; strategyCount: number }): void {
    this.activityLog?.append({
      category: "wake",
      action: "daily_brief_wake",
      detail: `Daily brief: ${brief.strategyCount} strategies, PnL $${brief.totalPnl.toFixed(2)}`,
      metadata: { totalPnl: brief.totalPnl, strategyCount: brief.strategyCount },
    });
    this.wake(
      `[findoo-trader] Daily brief ready: ${brief.strategyCount} strategies, PnL $${brief.totalPnl.toFixed(2)}. ` +
        `Use fin_fund_status for details and consider rebalancing if needed.`,
      "cron:findoo:daily-brief",
    );
  }

  /** Cold-start seed backtests completed — wake Agent to check promotions. */
  onSeedBacktestComplete(results: { completed: number; qualified: number }): void {
    this.activityLog?.append({
      category: "seed",
      action: "seed_backtest_complete",
      detail: `Cold-start backtests: ${results.completed} done, ${results.qualified} qualified`,
      metadata: { completed: results.completed, qualified: results.qualified },
    });
    this.wake(
      `[findoo-trader] Cold-start backtests done: ${results.completed} completed, ${results.qualified} qualified. ` +
        `Use fin_list_promotions_ready to review and promote eligible strategies.`,
      "cron:findoo:seed-backtest",
    );
  }

  /** Strategy eligible for promotion — wake Agent to execute. */
  onPromotionReady(info: { strategyId: string; from: string; to: string }): void {
    this.activityLog?.append({
      category: "promotion",
      action: "promotion_ready",
      strategyId: info.strategyId,
      detail: `Promotion ready: ${info.from} → ${info.to}`,
      metadata: { from: info.from, to: info.to },
    });
    this.wake(
      `[findoo-trader] Strategy ${info.strategyId} ready for promotion: ${info.from} → ${info.to}. ` +
        `Use fin_fund_promote to verify and fin_fund_rebalance to execute.`,
      `cron:findoo:promotion:${info.strategyId}`,
    );
  }

  /** Market ideation scan complete — wake Agent to analyze and generate strategies. */
  onIdeationScanComplete(info: { symbolCount: number; prompt: string }): void {
    this.activityLog?.append({
      category: "ideation",
      action: "ideation_scan_wake",
      detail: `Ideation scan: ${info.symbolCount} symbols analyzed. Waking LLM for strategy generation.`,
      metadata: { symbolCount: info.symbolCount },
    });
    this.wake(
      `[findoo-trader] Market ideation scan complete: ${info.symbolCount} symbols analyzed.\n\n${info.prompt}`,
      "cron:findoo:ideation-scan",
    );
  }

  /** L2→L3 requires user approval — wake Agent to notify user. */
  onApprovalNeeded(info: { strategyId: string; strategyName: string }): void {
    this.activityLog?.append({
      category: "approval",
      action: "approval_needed",
      strategyId: info.strategyId,
      detail: `"${info.strategyName}" eligible for L3_LIVE, awaiting user approval`,
    });
    this.wake(
      `[findoo-trader] Strategy "${info.strategyName}" (${info.strategyId}) is eligible for L3_LIVE promotion. ` +
        `This requires user confirmation. Notify the user and await their approval.`,
      `cron:findoo:approval:${info.strategyId}`,
    );
  }

  private wake(text: string, contextKey: string): void {
    // Track for pending wake reconciliation
    this.currentCycleFired.add(contextKey);
    const wakeId = `wake-${++this.wakeCounter}-${Date.now()}`;
    this.pendingWakes.set(contextKey, { wakeId, firedAt: Date.now(), contextKey });

    const sessionKey = this.resolveSessionKey();
    if (!sessionKey) return; // no active session — skip silently
    try {
      this.enqueue(text, { sessionKey, contextKey });
    } catch {
      // enqueue may throw if sessionKey is invalid — fail silently
    }
  }
}
