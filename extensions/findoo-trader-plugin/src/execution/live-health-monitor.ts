/**
 * Live Health Monitor — L3 circuit breaker.
 *
 * Detects cumulative loss on L3_LIVE strategies and triggers circuit break
 * (cancel all open orders + signal demotion to L2).
 *
 * This is the RULES layer for live trading risk. The LifecycleEngine calls
 * check() each cycle and acts on the result.
 */

import type { ActivityLogStore } from "../core/activity-log-store.js";
import type { AgentEventSqliteStore } from "../core/agent-event-sqlite-store.js";
import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";

// ── Duck-typed deps (avoid circular imports) ──

type LiveExecutorLike = {
  fetchBalance(exchangeId?: string): Promise<Record<string, unknown>>;
  cancelOrder(
    exchangeId: string | undefined,
    orderId: string,
    symbol: string,
  ): Promise<Record<string, unknown>>;
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

export interface LiveHealthThresholds {
  /** Max cumulative loss % before triggering circuit break (default 10). */
  maxCumulativeLossPct: number;
  /** Cooldown between alerts in ms (default 1 hour). */
  alertCooldownMs: number;
}

const DEFAULT_THRESHOLDS: LiveHealthThresholds = {
  maxCumulativeLossPct: 10,
  alertCooldownMs: 3_600_000,
};

// ── Monitor ──

export interface LiveHealthCheckResult {
  circuitBroken: boolean;
  lossPct: number;
  strategiesAffected: string[];
}

export class LiveHealthMonitor {
  private liveExecutor: LiveExecutorLike;
  private strategyRegistry: StrategyRegistryLike;
  private eventStore: AgentEventSqliteStore;
  private activityLog: ActivityLogStore;
  private wakeBridge?: AgentWakeBridge;
  private thresholds: LiveHealthThresholds;
  private lastAlertAt = 0;

  constructor(deps: {
    liveExecutor: LiveExecutorLike;
    strategyRegistry: StrategyRegistryLike;
    eventStore: AgentEventSqliteStore;
    activityLog: ActivityLogStore;
    wakeBridge?: AgentWakeBridge;
    thresholds?: Partial<LiveHealthThresholds>;
  }) {
    this.liveExecutor = deps.liveExecutor;
    this.strategyRegistry = deps.strategyRegistry;
    this.eventStore = deps.eventStore;
    this.activityLog = deps.activityLog;
    this.wakeBridge = deps.wakeBridge;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
  }

  /**
   * Check L3 live portfolio health. Returns circuit break status.
   * Called by LifecycleEngine each cycle.
   */
  async check(): Promise<LiveHealthCheckResult> {
    const l3Strategies = this.strategyRegistry
      .list({ level: "L3_LIVE" })
      .filter((s) => s.level === "L3_LIVE");

    if (l3Strategies.length === 0) {
      return { circuitBroken: false, lossPct: 0, strategiesAffected: [] };
    }

    let balance: Record<string, unknown>;
    try {
      balance = await this.liveExecutor.fetchBalance();
    } catch {
      return { circuitBroken: false, lossPct: 0, strategiesAffected: [] };
    }

    const totalEquity = Number(
      (balance as { total?: { USDT?: number } }).total?.USDT ??
        (balance as { info?: { totalEquity?: number } }).info?.totalEquity ??
        0,
    );
    const initialCapital = Number(
      (balance as { info?: { initialCapital?: number } }).info?.initialCapital ?? totalEquity,
    );

    if (initialCapital <= 0) {
      return { circuitBroken: false, lossPct: 0, strategiesAffected: [] };
    }

    const lossPct = ((initialCapital - totalEquity) / initialCapital) * 100;
    const strategiesAffected = l3Strategies.map((s) => s.id);

    if (lossPct >= this.thresholds.maxCumulativeLossPct) {
      const now = Date.now();
      if (now - this.lastAlertAt >= this.thresholds.alertCooldownMs) {
        this.lastAlertAt = now;

        this.eventStore.addEvent({
          type: "alert_triggered" as "alert_triggered",
          title: "L3 Circuit Breaker triggered",
          detail: `Cumulative loss ${lossPct.toFixed(1)}% ≥ ${this.thresholds.maxCumulativeLossPct}% threshold. Affected strategies: ${strategiesAffected.join(", ")}`,
          status: "completed",
        });

        this.activityLog.append({
          category: "risk",
          action: "l3_circuit_breaker",
          detail: `Circuit breaker: loss ${lossPct.toFixed(1)}%, threshold ${this.thresholds.maxCumulativeLossPct}%`,
          metadata: { lossPct, strategiesAffected },
        });

        this.wakeBridge?.onHealthAlert({
          accountId: "live",
          condition: "l3_circuit_breaker",
          value: lossPct,
        });
      }

      return { circuitBroken: true, lossPct, strategiesAffected };
    }

    return { circuitBroken: false, lossPct, strategiesAffected: [] };
  }
}
