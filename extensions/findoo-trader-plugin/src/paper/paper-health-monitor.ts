/**
 * Paper Health Monitor — deterministic condition detection + event emission.
 *
 * This is the RULES layer, not the DECISION layer:
 *   - Detects: DD > threshold, consecutive loss days, Sharpe < 0, decay level change
 *   - Emits: events to EventStore (SSE → Dashboard, Telegram notification)
 *   - Does NOT: promote, demote, kill, or take any action
 *   - LLM Agent: reads events via heartbeat → decides what to do
 *
 * Designed to run inside PaperScheduler's snapshot cycle (call check() after snapshotAll).
 */

import type { AgentEventSqliteStore } from "../core/agent-event-sqlite-store.js";
import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";

// ── Thresholds (configurable defaults) ──

export interface HealthThresholds {
  /** Max drawdown % before emitting alert (default 20). */
  maxDrawdownPct: number;
  /** Consecutive loss days before emitting alert (default 3). */
  maxConsecutiveLossDays: number;
  /** 7d Sharpe threshold — below this emits alert (default 0). */
  minSharpe7d: number;
  /** Cooldown between same-type alerts for same strategy in ms (default 1 hour). */
  alertCooldownMs: number;
}

const DEFAULT_THRESHOLDS: HealthThresholds = {
  maxDrawdownPct: 20,
  maxConsecutiveLossDays: 3,
  minSharpe7d: 0,
  alertCooldownMs: 3_600_000,
};

// ── Paper engine interface (minimal, no tight coupling) ──

type SnapshotLike = { timestamp: number; equity: number; dailyPnl: number };

type PaperAccountLike = {
  id: string;
  name: string;
  equity: number;
  initialCapital?: number;
};

type PaperEngineLike = {
  listAccounts(): PaperAccountLike[];
  getAccountState(id: string): { equity: number; initialCapital: number } | null;
  getSnapshots?(id: string): SnapshotLike[];
};

// ── Monitor ──

export class PaperHealthMonitor {
  private thresholds: HealthThresholds;
  private eventStore: AgentEventSqliteStore;
  private paperEngine: PaperEngineLike;
  private wakeBridge?: AgentWakeBridge;
  /** Dedup: strategyId:conditionKey → last emit timestamp */
  private lastEmitted = new Map<string, number>();

  constructor(deps: {
    eventStore: AgentEventSqliteStore;
    paperEngine: PaperEngineLike;
    thresholds?: Partial<HealthThresholds>;
    wakeBridge?: AgentWakeBridge;
  }) {
    this.eventStore = deps.eventStore;
    this.paperEngine = deps.paperEngine;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
    this.wakeBridge = deps.wakeBridge;
  }

  /** Late-bind the wake bridge (set after plugin registration). */
  setWakeBridge(bridge: AgentWakeBridge): void {
    this.wakeBridge = bridge;
  }

  /**
   * Run all condition checks. Call this after PaperScheduler.snapshotAll().
   * Returns the number of events emitted.
   */
  check(): number {
    let emitted = 0;
    const accounts = this.paperEngine.listAccounts();

    for (const acct of accounts) {
      const state = this.paperEngine.getAccountState(acct.id);
      if (!state) continue;

      const snapshots = this.paperEngine.getSnapshots?.(acct.id) ?? [];

      // ── Condition 1: Drawdown ──
      if (state.initialCapital > 0) {
        const dd = ((state.initialCapital - state.equity) / state.initialCapital) * 100;
        if (dd >= this.thresholds.maxDrawdownPct) {
          const n = this.emit(acct.id, "drawdown", {
            type: "alert_triggered",
            title: `Paper DD alert: ${acct.name ?? acct.id}`,
            detail: `Drawdown ${dd.toFixed(1)}% ≥ ${this.thresholds.maxDrawdownPct}% threshold. Equity: $${state.equity.toFixed(2)}, Initial: $${state.initialCapital.toFixed(2)}`,
          });
          if (n > 0)
            this.wakeBridge?.onHealthAlert({
              accountId: acct.id,
              condition: "drawdown",
              value: dd,
            });
          emitted += n;
        }
      }

      // ── Condition 2: Consecutive loss days ──
      if (snapshots.length >= this.thresholds.maxConsecutiveLossDays) {
        const recent = snapshots.slice(-this.thresholds.maxConsecutiveLossDays);
        const allLoss = recent.every((s) => s.dailyPnl < 0);
        if (allLoss) {
          const n = this.emit(acct.id, "consecutive_loss", {
            type: "alert_triggered",
            title: `Paper consecutive loss: ${acct.name ?? acct.id}`,
            detail: `${recent.length} consecutive loss days. Recent PnL: ${recent.map((s) => `$${s.dailyPnl.toFixed(2)}`).join(", ")}`,
          });
          if (n > 0)
            this.wakeBridge?.onHealthAlert({
              accountId: acct.id,
              condition: "consecutive_loss",
              value: recent.length,
            });
          emitted += n;
        }
      }

      // ── Condition 3: 7d rolling Sharpe < threshold ──
      if (snapshots.length >= 7) {
        const last7 = snapshots.slice(-7);
        const returns = last7.map((s) => (s.equity > 0 ? s.dailyPnl / s.equity : 0));
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        const sharpe7d = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

        if (sharpe7d < this.thresholds.minSharpe7d) {
          const n = this.emit(acct.id, "low_sharpe", {
            type: "alert_triggered",
            title: `Paper low Sharpe: ${acct.name ?? acct.id}`,
            detail: `7d Sharpe ${sharpe7d.toFixed(2)} < ${this.thresholds.minSharpe7d} threshold`,
          });
          if (n > 0)
            this.wakeBridge?.onHealthAlert({
              accountId: acct.id,
              condition: "low_sharpe",
              value: sharpe7d,
            });
          emitted += n;
        }
      }
    }

    return emitted;
  }

  /** Emit an event with cooldown dedup. Returns 1 if emitted, 0 if suppressed. */
  private emit(
    accountId: string,
    conditionKey: string,
    event: { type: string; title: string; detail: string },
  ): number {
    const key = `${accountId}:${conditionKey}`;
    const now = Date.now();
    const last = this.lastEmitted.get(key);

    if (last && now - last < this.thresholds.alertCooldownMs) {
      return 0; // cooldown active
    }

    this.lastEmitted.set(key, now);
    this.eventStore.addEvent({
      type: event.type as "alert_triggered",
      title: event.title,
      detail: event.detail,
      status: "completed",
    });
    return 1;
  }
}
