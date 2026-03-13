/**
 * Live Reconciler — compares L3 Live positions vs Paper shadow positions
 * to detect drift that could indicate execution issues or config divergence.
 *
 * Severity levels:
 *   - ok: drift < warningDriftPct
 *   - warning: drift ≥ warningDriftPct && < criticalDriftPct
 *   - critical: drift ≥ criticalDriftPct
 *
 * When a strategy has 2+ consecutive critical cycles, the LifecycleEngine
 * triggers auto-demotion to L2.
 */

import type { ActivityLogStore } from "../core/activity-log-store.js";
import type { AgentEventSqliteStore } from "../core/agent-event-sqlite-store.js";
import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";

// ── Duck-typed deps ──

type LiveExecutorLike = {
  fetchPositions(exchangeId?: string, symbol?: string): Promise<unknown[]>;
};

type PaperEngineLike = {
  listAccounts(): Array<{ id: string }>;
  getAccountState(id: string): { positions: Array<Record<string, unknown>> } | null;
};

type StrategyRegistryLike = {
  list(filter?: { level?: string }): Array<{
    id: string;
    name: string;
    level: string;
    definition: { symbols: string[] };
  }>;
};

// ── Thresholds ──

export interface ReconcilerThresholds {
  /** Drift % at which a warning is emitted (default 15). */
  warningDriftPct: number;
  /** Drift % at which severity becomes critical (default 30). */
  criticalDriftPct: number;
  /** Cooldown between alerts per strategy in ms (default 1 hour). */
  alertCooldownMs: number;
}

const DEFAULT_THRESHOLDS: ReconcilerThresholds = {
  warningDriftPct: 10,
  criticalDriftPct: 20,
  alertCooldownMs: 3_600_000,
};

// ── Result types ──

export type DriftSeverity = "ok" | "warning" | "critical";

export interface DriftResult {
  strategyId: string;
  symbol: string;
  liveQty: number;
  paperQty: number;
  driftPct: number;
  severity: DriftSeverity;
}

// ── Reconciler ──

export class LiveReconciler {
  private liveExecutor: LiveExecutorLike;
  private paperEngine: PaperEngineLike;
  private strategyRegistry: StrategyRegistryLike;
  private eventStore: AgentEventSqliteStore;
  private activityLog: ActivityLogStore;
  private wakeBridge?: AgentWakeBridge;
  private thresholds: ReconcilerThresholds;
  private consecutiveCriticalCycles = new Map<string, number>();
  private lastAlertAt = new Map<string, number>();

  constructor(deps: {
    liveExecutor: LiveExecutorLike;
    paperEngine: PaperEngineLike;
    strategyRegistry: StrategyRegistryLike;
    eventStore: AgentEventSqliteStore;
    activityLog: ActivityLogStore;
    wakeBridge?: AgentWakeBridge;
    thresholds?: Partial<ReconcilerThresholds>;
  }) {
    this.liveExecutor = deps.liveExecutor;
    this.paperEngine = deps.paperEngine;
    this.strategyRegistry = deps.strategyRegistry;
    this.eventStore = deps.eventStore;
    this.activityLog = deps.activityLog;
    this.wakeBridge = deps.wakeBridge;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
  }

  /** How many consecutive critical cycles for a given strategy. */
  getConsecutiveCritical(strategyId: string): number {
    return this.consecutiveCriticalCycles.get(strategyId) ?? 0;
  }

  /**
   * Compare live positions vs paper positions for all L3 strategies.
   * Returns per-strategy max drift.
   */
  async reconcile(): Promise<DriftResult[]> {
    const l3Strategies = this.strategyRegistry
      .list({ level: "L3_LIVE" })
      .filter((s) => s.level === "L3_LIVE");

    if (l3Strategies.length === 0) return [];

    // Fetch live positions
    let livePositions: unknown[];
    try {
      livePositions = await this.liveExecutor.fetchPositions();
    } catch {
      return [];
    }

    // Build live position map: symbol → quantity
    const liveBySymbol = new Map<string, number>();
    for (const pos of livePositions) {
      const p = pos as { symbol?: string; contracts?: number; info?: { positionAmt?: string } };
      const sym = p.symbol;
      if (!sym) continue;
      const qty = Math.abs(p.contracts ?? Number(p.info?.positionAmt ?? 0));
      liveBySymbol.set(sym, (liveBySymbol.get(sym) ?? 0) + qty);
    }

    // Fetch paper positions
    const accounts = this.paperEngine.listAccounts();
    const paperBySymbol = new Map<string, number>();
    for (const acct of accounts) {
      const state = this.paperEngine.getAccountState(acct.id);
      if (!state) continue;
      for (const pos of state.positions) {
        const p = pos as { symbol?: string; quantity?: number };
        if (!p.symbol) continue;
        const qty = Math.abs(p.quantity ?? 0);
        paperBySymbol.set(p.symbol, (paperBySymbol.get(p.symbol) ?? 0) + qty);
      }
    }

    const results: DriftResult[] = [];

    for (const strategy of l3Strategies) {
      let maxDrift: DriftResult | null = null;

      for (const symbol of strategy.definition.symbols) {
        const liveQty = liveBySymbol.get(symbol) ?? 0;
        const paperQty = paperBySymbol.get(symbol) ?? 0;
        const maxQty = Math.max(liveQty, paperQty);
        const driftPct = maxQty > 0 ? (Math.abs(liveQty - paperQty) / maxQty) * 100 : 0;

        const severity: DriftSeverity =
          driftPct >= this.thresholds.criticalDriftPct
            ? "critical"
            : driftPct >= this.thresholds.warningDriftPct
              ? "warning"
              : "ok";

        const drift: DriftResult = {
          strategyId: strategy.id,
          symbol,
          liveQty,
          paperQty,
          driftPct,
          severity,
        };

        if (!maxDrift || driftPct > maxDrift.driftPct) {
          maxDrift = drift;
        }
      }

      if (maxDrift) {
        results.push(maxDrift);
        this.trackConsecutive(strategy.id, strategy.name, maxDrift);
      }
    }

    return results;
  }

  private trackConsecutive(strategyId: string, name: string, drift: DriftResult): void {
    if (drift.severity === "critical") {
      const count = (this.consecutiveCriticalCycles.get(strategyId) ?? 0) + 1;
      this.consecutiveCriticalCycles.set(strategyId, count);

      const now = Date.now();
      const lastAlert = this.lastAlertAt.get(strategyId) ?? 0;

      if (now - lastAlert >= this.thresholds.alertCooldownMs) {
        this.lastAlertAt.set(strategyId, now);

        this.eventStore.addEvent({
          type: "alert_triggered" as "alert_triggered",
          title: `L3 Drift alert: ${name}`,
          detail: `Position drift ${drift.driftPct.toFixed(1)}% on ${drift.symbol} (live=${drift.liveQty}, paper=${drift.paperQty}). Consecutive critical cycles: ${count}`,
          status: "completed",
        });

        this.activityLog.append({
          category: "risk",
          action: "l3_position_drift",
          strategyId,
          detail: `Drift ${drift.driftPct.toFixed(1)}% on ${drift.symbol}, consecutive=${count}`,
          metadata: { driftPct: drift.driftPct, symbol: drift.symbol, consecutiveCritical: count },
        });

        if (count >= 2) {
          this.wakeBridge?.onHealthAlert({
            accountId: "live",
            condition: "l3_position_drift",
            value: drift.driftPct,
          });
        }
      }
    } else {
      // Reset consecutive counter on non-critical
      this.consecutiveCriticalCycles.delete(strategyId);
    }
  }
}
