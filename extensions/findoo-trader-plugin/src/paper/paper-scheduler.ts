import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";
import type { PerformanceSnapshotStore } from "../fund/performance-snapshot-store.js";
import type { OHLCV, StrategyContext, StrategyDefinition, Signal } from "../shared/types.js";
import { buildIndicatorLib } from "../strategy/indicator-lib.js";
import type { PaperHealthMonitor } from "./paper-health-monitor.js";

type DataProviderLike = {
  getOHLCV: (
    paramsOrSymbol: { symbol: string; market: string; timeframe: string; limit?: number } | string,
    timeframe?: string,
    limit?: number,
  ) => Promise<OHLCV[]>;
};

type PaperEngineLike = {
  listAccounts(): Array<{ id: string; name: string; equity: number }>;
  getAccountState(
    id: string,
  ): { equity: number; cash?: number; positions: Array<Record<string, unknown>> } | null;
  submitOrder(
    accountId: string,
    order: Record<string, unknown>,
    currentPrice: number,
  ): Record<string, unknown>;
  recordSnapshot(accountId: string): void;
  getSnapshots?(
    id: string,
  ): Array<{ timestamp: number; equity: number; dailyPnl: number; dailyPnlPct: number }>;
};

type StrategyRegistryLike = {
  list(filter?: { level?: string }): Array<{
    id: string;
    name: string;
    level: string;
    definition: StrategyDefinition;
  }>;
};

type RegimeDetectorLike = {
  detect: (ohlcv: OHLCV[]) => string;
};

export type PaperSchedulerConfig = {
  paperEngine: PaperEngineLike;
  strategyRegistry: StrategyRegistryLike;
  dataProvider?: DataProviderLike;
  perfStore?: PerformanceSnapshotStore;
  /** Optional health monitor — runs condition checks after each snapshot cycle. */
  healthMonitor?: PaperHealthMonitor;
  /** Optional wake bridge — notifies Agent of promotion-ready strategies. */
  wakeBridge?: AgentWakeBridge;
  /** Lazy resolver for dataProvider — called on each tick if dataProvider is still unset. */
  serviceResolver?: () => DataProviderLike | undefined;
  /** Lazy resolver for regime detector — returns real market regime instead of hardcoded "sideways". */
  regimeDetectorResolver?: () => RegimeDetectorLike | undefined;
  /** @deprecated Promotion checks moved to LifecycleEngine. Kept for backward compat. */
  fundManagerResolver?: () => FundManagerLike | undefined;
  tickIntervalMs?: number; // default 60_000 (1 min)
  snapshotIntervalMs?: number; // default 3_600_000 (1 hour)
};

type FundManagerLike = {
  buildProfiles: (records: unknown[]) => Array<{ strategyId: string; currentLevel: string }>;
  checkPromotion: (profile: { strategyId: string; currentLevel: string }) => {
    eligible: boolean;
    targetLevel?: string;
    needsUserConfirmation?: boolean;
  };
};

/** Returns true if `last` is null or from a different calendar day than now. */
export function isNewDay(last: Date | null): boolean {
  if (!last) return true;
  const now = new Date();
  return now.toDateString() !== last.toDateString();
}

export class PaperScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private errorCount = 0;
  private _deps: PaperSchedulerConfig;
  private lastPerfSnapshotDate: Date | null = null;

  constructor(deps: PaperSchedulerConfig) {
    this._deps = deps;
  }

  /** Expose deps for late-binding (e.g., dataProvider injected after plugin registration). */
  get deps(): PaperSchedulerConfig {
    return this._deps;
  }

  start(): void {
    if (this.tickTimer) return; // already running
    const tickMs = this._deps.tickIntervalMs ?? 60_000;
    const snapMs = this._deps.snapshotIntervalMs ?? 3_600_000;
    this.tickTimer = setInterval(() => void this.tickAll(), tickMs);
    this.snapshotTimer = setInterval(() => void this.snapshotAll(), snapMs);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  getStats(): { running: boolean; tickCount: number; errorCount: number } {
    return {
      running: this.tickTimer !== null,
      tickCount: this.tickCount,
      errorCount: this.errorCount,
    };
  }

  async tickAll(): Promise<{ ticked: number; signals: number; errors: number }> {
    // Lazy service resolution: try to acquire dataProvider if not yet set
    if (!this._deps.dataProvider && this._deps.serviceResolver) {
      const resolved = this._deps.serviceResolver();
      if (resolved) this._deps.dataProvider = resolved;
    }

    const { paperEngine, strategyRegistry, dataProvider } = this._deps;
    if (!dataProvider) return { ticked: 0, signals: 0, errors: 0 };

    const l2Strategies = strategyRegistry
      .list({ level: "L2_PAPER" })
      .filter((s) => s.level === "L2_PAPER");

    let signals = 0;
    let errors = 0;

    for (const record of l2Strategies) {
      try {
        const symbol = record.definition.symbols[0] ?? "BTC/USDT";
        const timeframe = record.definition.timeframes[0] ?? "1h";
        const market = record.definition.markets[0] ?? "crypto";

        // Runtime provider (datahub) uses object-style params
        const ohlcv = await (dataProvider as any).getOHLCV({
          symbol,
          market,
          timeframe,
          limit: 200,
        });

        if (!ohlcv || ohlcv.length === 0) continue;

        const latestBar = ohlcv[ohlcv.length - 1]!;
        const indicators = buildIndicatorLib(ohlcv);

        // Resolve paper account dynamically (IDs are paper-{uuid}, not "default")
        const accounts = paperEngine.listAccounts();
        const activeAccountId = accounts[0]?.id;

        const portfolio = (activeAccountId
          ? paperEngine.getAccountState(activeAccountId)
          : null) ?? {
          equity: 10000,
          cash: 10000,
          positions: [],
        };

        const ctx: StrategyContext = {
          portfolio: {
            equity: (portfolio as { equity: number }).equity,
            cash: (portfolio as { cash?: number }).cash ?? (portfolio as { equity: number }).equity,
            positions: [],
          },
          history: ohlcv,
          indicators,
          regime: this._deps.regimeDetectorResolver?.()?.detect(ohlcv) ?? "sideways",
          memory: new Map(),
          log: () => {},
        };

        const signal = await record.definition.onBar(latestBar, ctx);

        if (signal && activeAccountId) {
          signals++;
          const quantity = ((signal.sizePct / 100) * ctx.portfolio.equity) / latestBar.close;
          paperEngine.submitOrder(
            activeAccountId,
            {
              symbol: signal.symbol || symbol,
              side: signal.action === "buy" ? "buy" : "sell",
              type: signal.orderType,
              quantity,
              strategyId: record.id,
              reason: signal.reason,
            },
            latestBar.close,
          );
        }
      } catch {
        errors++;
        this.errorCount++;
      }
    }

    this.tickCount++;
    return { ticked: l2Strategies.length, signals, errors };
  }

  async snapshotAll(): Promise<{ snapshots: number }> {
    const { paperEngine, perfStore } = this._deps;
    const accounts = paperEngine.listAccounts();
    for (const acct of accounts) {
      try {
        paperEngine.recordSnapshot(acct.id);
      } catch {
        this.errorCount++;
      }
    }

    // Write daily performance snapshot if new day
    if (perfStore && isNewDay(this.lastPerfSnapshotDate)) {
      try {
        this.writeDailyPerfSnapshot();
        this.lastPerfSnapshotDate = new Date();
      } catch {
        this.errorCount++;
      }
    }

    // Run health condition checks after snapshot (rules layer → event emission)
    if (this._deps.healthMonitor) {
      try {
        this._deps.healthMonitor.check();
      } catch {
        this.errorCount++;
      }
    }

    // Promotion checks are now handled by LifecycleEngine (runs every 5 min).
    // PaperScheduler focuses only on ticking strategies and recording snapshots.

    return { snapshots: accounts.length };
  }

  private writeDailyPerfSnapshot(): void {
    const { paperEngine, perfStore } = this._deps;
    if (!perfStore) return;

    const accounts = paperEngine.listAccounts();
    let totalPnl = 0;
    let totalEquity = 0;
    let totalInitialCapital = 0;
    let peakEquity = 0;
    const byStrategy: Record<string, number> = {};
    const byMarket: Record<string, number> = {};
    const bySymbol: Record<string, number> = {};

    for (const acct of accounts) {
      const state = paperEngine.getAccountState(acct.id);
      if (!state) continue;

      totalEquity += state.equity;
      totalInitialCapital += acct.equity;

      // Track per-position breakdowns
      for (const pos of state.positions) {
        const pnl = (pos as { unrealizedPnl?: number }).unrealizedPnl ?? 0;
        const sym = (pos as { symbol?: string }).symbol ?? "unknown";
        const stratId = (pos as { strategyId?: string }).strategyId ?? "manual";
        bySymbol[sym] = (bySymbol[sym] ?? 0) + pnl;
        byStrategy[stratId] = (byStrategy[stratId] ?? 0) + pnl;
      }

      // Get snapshots for daily PnL
      const snapshots = paperEngine.getSnapshots?.(acct.id) ?? [];
      if (snapshots.length > 0) {
        totalPnl += snapshots[snapshots.length - 1]!.dailyPnl;
      }

      if (state.equity > peakEquity) peakEquity = state.equity;
    }

    const totalReturn =
      totalInitialCapital > 0
        ? ((totalEquity - totalInitialCapital) / totalInitialCapital) * 100
        : 0;
    const maxDrawdown = peakEquity > 0 ? ((totalEquity - peakEquity) / peakEquity) * 100 : 0;

    const now = new Date();
    const period = now.toISOString().slice(0, 10); // YYYY-MM-DD

    perfStore.addSnapshot({
      id: `daily-${period}`,
      period,
      periodType: "daily",
      totalPnl,
      totalReturn,
      sharpe: null, // Would need historical series to compute
      maxDrawdown: maxDrawdown < 0 ? maxDrawdown : null,
      byStrategyJson: Object.keys(byStrategy).length > 0 ? JSON.stringify(byStrategy) : null,
      byMarketJson: Object.keys(byMarket).length > 0 ? JSON.stringify(byMarket) : null,
      bySymbolJson: Object.keys(bySymbol).length > 0 ? JSON.stringify(bySymbol) : null,
      createdAt: now.getTime(),
    });
  }
}
