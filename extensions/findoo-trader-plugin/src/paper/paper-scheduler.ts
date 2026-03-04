import type { OHLCV, StrategyContext, StrategyDefinition, Signal } from "../shared/types.js";
import { buildIndicatorLib } from "../strategy/backtest-engine.js";

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
};

type StrategyRegistryLike = {
  list(filter?: { level?: string }): Array<{
    id: string;
    name: string;
    level: string;
    definition: StrategyDefinition;
  }>;
};

export type PaperSchedulerConfig = {
  paperEngine: PaperEngineLike;
  strategyRegistry: StrategyRegistryLike;
  dataProvider?: DataProviderLike;
  tickIntervalMs?: number; // default 60_000 (1 min)
  snapshotIntervalMs?: number; // default 3_600_000 (1 hour)
};

export class PaperScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private errorCount = 0;
  private _deps: PaperSchedulerConfig;

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

        const getOHLCV = dataProvider.getOHLCV;
        const ohlcv =
          getOHLCV.length <= 1
            ? await getOHLCV({ symbol, market, timeframe, limit: 200 })
            : await getOHLCV(symbol, timeframe, 200);

        if (!ohlcv || ohlcv.length === 0) continue;

        const latestBar = ohlcv[ohlcv.length - 1]!;
        const indicators = buildIndicatorLib(ohlcv);

        const portfolio = paperEngine.getAccountState("default") ?? {
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
          regime: "sideways",
          memory: new Map(),
          log: () => {},
        };

        const signal = await record.definition.onBar(latestBar, ctx);

        if (signal) {
          signals++;
          const quantity = ((signal.sizePct / 100) * ctx.portfolio.equity) / latestBar.close;
          paperEngine.submitOrder(
            "default",
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
    const { paperEngine } = this._deps;
    const accounts = paperEngine.listAccounts();
    for (const acct of accounts) {
      try {
        paperEngine.recordSnapshot(acct.id);
      } catch {
        this.errorCount++;
      }
    }
    return { snapshots: accounts.length };
  }
}
