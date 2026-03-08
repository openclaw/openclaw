import type { DailyBrief } from "../types.js";
import type { AgentWakeBridge } from "./agent-wake-bridge.js";

type PaperEngineLike = {
  listAccounts(): Array<{ id: string; name: string; equity: number }>;
  getAccountState(
    id: string,
  ): { equity: number; cash?: number; positions: Array<Record<string, unknown>> } | null;
  getSnapshots?(id: string): Array<{ dailyPnl: number }>;
};

type StrategyRegistryLike = {
  list(filter?: { level?: string }): Array<{
    id: string;
    name: string;
    level: string;
    lastBacktest?: { totalReturn: number };
  }>;
};

type EventStoreLike = {
  addEvent(input: { type: string; title: string; detail: string; status: string }): {
    id: string;
    timestamp: number;
  };
};

type LiveExecutorLike = {
  fetchBalance(exchangeId?: string): Promise<Record<string, unknown>>;
};

export type DailyBriefSchedulerConfig = {
  paperEngine?: PaperEngineLike;
  strategyRegistry?: StrategyRegistryLike;
  eventStore?: EventStoreLike;
  wakeBridge?: AgentWakeBridge;
  liveExecutor?: LiveExecutorLike;
  intervalMs?: number; // default 86_400_000 (24h)
};

export class DailyBriefScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private briefCount = 0;
  private lastBriefAt: number | null = null;
  private lastBrief: DailyBrief | null = null;
  private _deps: DailyBriefSchedulerConfig;

  constructor(deps: DailyBriefSchedulerConfig) {
    this._deps = deps;
  }

  get deps(): DailyBriefSchedulerConfig {
    return this._deps;
  }

  start(): void {
    if (this.timer) return;
    const ms = this._deps.intervalMs ?? 86_400_000;
    this.timer = setInterval(() => void this.generateBrief(), ms);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStats(): { running: boolean; briefCount: number; lastBriefAt: number | null } {
    return {
      running: this.timer !== null,
      briefCount: this.briefCount,
      lastBriefAt: this.lastBriefAt,
    };
  }

  getLastBrief(): DailyBrief | null {
    return this.lastBrief;
  }

  async generateBrief(): Promise<DailyBrief> {
    const { paperEngine, strategyRegistry, eventStore } = this._deps;

    // Aggregate portfolio data
    let totalEquity = 0;
    let dailyPnl = 0;
    if (paperEngine) {
      const accounts = paperEngine.listAccounts();
      for (const acct of accounts) {
        totalEquity += acct.equity;
        // Read actual dailyPnl from latest equity snapshot
        const snapshots = paperEngine.getSnapshots?.(acct.id) ?? [];
        if (snapshots.length > 0) {
          dailyPnl += snapshots[snapshots.length - 1]!.dailyPnl;
        }
      }
    }
    const dailyPnlPct = totalEquity > 0 ? (dailyPnl / totalEquity) * 100 : 0;

    // Fetch live exchange equity
    let liveEquity = 0;
    if (this._deps.liveExecutor) {
      try {
        const bal = await this._deps.liveExecutor.fetchBalance();
        liveEquity = Number((bal as { total?: { USDT?: number } }).total?.USDT ?? 0);
      } catch {
        /* exchange offline — degrade gracefully */
      }
    }

    // Find top/worst strategies by last backtest return
    let topStrategy: DailyBrief["topStrategy"];
    let worstStrategy: DailyBrief["worstStrategy"];
    const alerts: string[] = [];

    if (strategyRegistry) {
      const strategies = strategyRegistry.list();
      let bestReturn = -Infinity;
      let worstReturn = Infinity;

      for (const s of strategies) {
        const ret = s.lastBacktest?.totalReturn ?? 0;
        if (ret > bestReturn) {
          bestReturn = ret;
          topStrategy = { id: s.id, name: s.name, dailyReturn: ret };
        }
        if (ret < worstReturn) {
          worstReturn = ret;
          worstStrategy = { id: s.id, name: s.name, dailyReturn: ret };
        }
      }

      // Alert if any strategy has negative return
      for (const s of strategies) {
        if ((s.lastBacktest?.totalReturn ?? 0) < -0.1) {
          alerts.push(
            `${s.name} underperforming (${((s.lastBacktest?.totalReturn ?? 0) * 100).toFixed(1)}%)`,
          );
        }
      }
    }

    const brief: DailyBrief = {
      date: new Date().toISOString().split("T")[0]!,
      marketSummary:
        "Market data aggregation pending — connect a data provider for live summaries.",
      portfolioChange: { totalEquity, dailyPnl, dailyPnlPct },
      liveEquity,
      topStrategy,
      worstStrategy,
      alerts,
      recommendation:
        alerts.length > 0
          ? "Review underperforming strategies and consider rebalancing."
          : "Portfolio is performing within normal parameters.",
    };

    // Write to event store
    if (eventStore) {
      const liveLabel = liveEquity > 0 ? ` | Live: $${liveEquity.toFixed(2)}` : "";
      eventStore.addEvent({
        type: "system",
        title: "Daily Brief",
        detail: `Paper: $${totalEquity.toFixed(2)}${liveLabel} | Strategies: ${strategyRegistry?.list().length ?? 0} | Alerts: ${alerts.length}`,
        status: "completed",
      });
    }

    this.briefCount++;
    this.lastBriefAt = Date.now();
    this.lastBrief = brief;

    // Wake Agent to deliver brief summary
    this._deps.wakeBridge?.onDailyBriefReady({
      totalPnl: dailyPnl,
      strategyCount: strategyRegistry?.list().length ?? 0,
    });

    return brief;
  }
}
