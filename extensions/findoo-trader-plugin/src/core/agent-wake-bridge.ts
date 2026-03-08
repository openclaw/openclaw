/**
 * Agent Wake Bridge — bridges findoo-trader-plugin internal events to the
 * OpenClaw heartbeat system event queue.
 *
 * When HealthMonitor detects an alert, DailyBrief completes, ColdStartSeeder
 * finishes backtests, or a strategy reaches promotion eligibility, this bridge
 * calls enqueueSystemEvent() to wake the heartbeat runner so the LLM agent
 * can autonomously respond.
 *
 * Wake events are persisted to SQLite so they survive gateway restarts.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActivityLogStore } from "./activity-log-store.js";

type EnqueueFn = (text: string, options: { sessionKey: string; contextKey?: string }) => void;

export interface AgentWakeBridgeConfig {
  enqueueSystemEvent: EnqueueFn;
  /** Resolves the active heartbeat session key at call time. */
  sessionKeyResolver: () => string | undefined;
  /** Optional activity log — every wake event is recorded for the Flow timeline. */
  activityLog?: ActivityLogStore;
  /** SQLite path for persisting pending wakes across restarts. */
  dbPath?: string;
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
  private db?: DatabaseSync;

  constructor(config: AgentWakeBridgeConfig) {
    this.enqueue = config.enqueueSystemEvent;
    this.resolveSessionKey = config.sessionKeyResolver;
    this.activityLog = config.activityLog;

    if (config.dbPath) {
      mkdirSync(dirname(config.dbPath), { recursive: true });
      this.db = new DatabaseSync(config.dbPath);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_wakes (
          wake_id TEXT PRIMARY KEY,
          context_key TEXT NOT NULL UNIQUE,
          text TEXT NOT NULL,
          fired_at INTEGER NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0
        )
      `);
    }
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
        // Clean from SQLite too
        try {
          this.db?.prepare("DELETE FROM pending_wakes WHERE context_key = ?").run(key);
        } catch {
          /* non-critical */
        }
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

  /**
   * Retry delivering any undelivered wakes from SQLite.
   * Called on gateway start and after each lifecycle cycle.
   */
  drainUndelivered(): number {
    if (!this.db) return 0;
    let delivered = 0;
    const sessionKey = this.resolveSessionKey();
    if (!sessionKey) return 0;

    try {
      const rows = this.db
        .prepare(
          "SELECT wake_id, context_key, text, fired_at FROM pending_wakes WHERE delivered = 0",
        )
        .all() as Array<{ wake_id: string; context_key: string; text: string; fired_at: number }>;

      for (const row of rows) {
        try {
          this.enqueue(row.text, { sessionKey, contextKey: row.context_key });
          this.db
            .prepare("UPDATE pending_wakes SET delivered = 1 WHERE wake_id = ?")
            .run(row.wake_id);
          delivered++;
          this.activityLog?.append({
            category: "wake",
            action: "wake_drain_delivered",
            detail: `Drained undelivered wake: ${row.context_key}`,
            metadata: { wakeId: row.wake_id, contextKey: row.context_key },
          });
        } catch {
          /* individual enqueue failure — will retry next cycle */
        }
      }
    } catch {
      /* db read failure — non-critical */
    }

    return delivered;
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

  /**
   * Lifecycle engine detected actions that need Agent decision.
   * Instead of auto-executing, it delegates to the Agent via this wake event.
   */
  onLifecycleRecommendation(info: {
    promotions: Array<{
      strategyId: string;
      name: string;
      from: string;
      to: string;
      reasons: string[];
    }>;
    demotions: Array<{
      strategyId: string;
      name: string;
      from: string;
      to: string;
      reasons: string[];
    }>;
  }): void {
    const promoCount = info.promotions.length;
    const demoCount = info.demotions.length;
    if (promoCount === 0 && demoCount === 0) return;

    const summary = [
      promoCount > 0 ? `${promoCount} promotion(s) recommended` : "",
      demoCount > 0 ? `${demoCount} demotion(s) recommended` : "",
    ]
      .filter(Boolean)
      .join(", ");

    this.activityLog?.append({
      category: "lifecycle",
      action: "lifecycle_recommendation",
      detail: `Lifecycle scan: ${summary}`,
      metadata: { promotions: info.promotions, demotions: info.demotions },
    });
    this.wake(
      `[findoo-trader] Lifecycle scan found actions: ${summary}. ` +
        `Call fin_lifecycle_scan to review the full action list and make decisions. ` +
        `Use fin_fund_rebalance to execute promotions/demotions.`,
      "cron:findoo:lifecycle-recommendation",
      { cooldownMs: 30 * 60_000 }, // 30min cooldown — lifecycle runs every 5m
    );
  }

  /** Evolution scheduler detected alpha decay — wake Agent to decide. */
  onEvolutionNeeded(info: {
    strategyId: string;
    name: string;
    classification: string;
    halfLifeDays: number;
  }): void {
    this.activityLog?.append({
      category: "evolution",
      action: "evolution_needed_wake",
      strategyId: info.strategyId,
      detail: `Alpha decay detected on "${info.name}": ${info.classification} (half-life: ${info.halfLifeDays.toFixed(0)}d)`,
      metadata: {
        strategyId: info.strategyId,
        classification: info.classification,
        halfLifeDays: info.halfLifeDays,
      },
    });
    this.wake(
      `[findoo-trader] Strategy "${info.name}" alpha decay detected: ` +
        `${info.classification} (half-life: ${info.halfLifeDays.toFixed(0)} days). ` +
        `Use fin_evolve_trigger to evolve parameters, or fin_fund_status to review.`,
      `cron:findoo:evolution-needed:${info.strategyId}`,
      { cooldownMs: 4 * 60 * 60_000 }, // 4h cooldown — decay is a slow process
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

  private wake(text: string, contextKey: string, opts?: { cooldownMs?: number }): void {
    // TTL cooldown: skip if same contextKey was fired recently
    if (opts?.cooldownMs) {
      const existing = this.pendingWakes.get(contextKey);
      if (existing && Date.now() - existing.firedAt < opts.cooldownMs) {
        return; // still within cooldown period
      }
    }

    // Track for pending wake reconciliation
    this.currentCycleFired.add(contextKey);
    const wakeId = `wake-${++this.wakeCounter}-${Date.now()}`;
    this.pendingWakes.set(contextKey, { wakeId, firedAt: Date.now(), contextKey });

    // Persist to SQLite first (survives restart)
    try {
      this.db
        ?.prepare(
          "INSERT OR REPLACE INTO pending_wakes (wake_id, context_key, text, fired_at, delivered) VALUES (?, ?, ?, ?, 0)",
        )
        .run(wakeId, contextKey, text, Date.now());
    } catch {
      /* SQLite write failure — continue with in-memory */
    }

    const sessionKey = this.resolveSessionKey();
    if (!sessionKey) {
      // No active session — event is persisted in SQLite, will be delivered via drainUndelivered()
      this.activityLog?.append({
        category: "wake",
        action: "wake_deferred",
        detail: `Wake deferred (no session): ${contextKey}`,
        metadata: { wakeId, contextKey },
      });
      return;
    }
    try {
      this.enqueue(text, { sessionKey, contextKey });
      // Mark as delivered in SQLite
      try {
        this.db?.prepare("UPDATE pending_wakes SET delivered = 1 WHERE wake_id = ?").run(wakeId);
      } catch {
        /* non-critical */
      }
    } catch {
      // enqueue failed — event stays in SQLite for retry
      this.activityLog?.append({
        category: "wake",
        action: "wake_enqueue_failed",
        detail: `Wake enqueue failed, persisted for retry: ${contextKey}`,
        metadata: { wakeId, contextKey },
      });
    }
  }
}
