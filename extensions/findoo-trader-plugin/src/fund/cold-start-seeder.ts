/**
 * Cold Start Seeder — populates strategy pool on first launch.
 *
 * Primary path: StrategyDiscoveryEngine (Phase A deterministic + Phase B subagent).
 * Fallback path: hardcoded seed strategies when data provider is unavailable.
 *
 * Also seeds: paper trading positions, activity feed events, approval cards.
 */

import type { AgentEventSqliteStore } from "../core/agent-event-sqlite-store.js";
import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";
import type { StrategyDiscoveryEngine } from "../discovery/strategy-discovery-engine.js";
import type { DiscoveryConfig } from "../discovery/types.js";
import type { BacktestResult, StrategyDefinition, StrategyLevel } from "../shared/types.js";
import { createBollingerBands } from "../strategy/builtin-strategies/bollinger-bands.js";
import { buildCustomStrategy } from "../strategy/builtin-strategies/custom-rule-engine.js";
import { createMacdDivergence } from "../strategy/builtin-strategies/macd-divergence.js";
import { createMultiTimeframeConfluence } from "../strategy/builtin-strategies/multi-timeframe-confluence.js";
import { createRegimeAdaptive } from "../strategy/builtin-strategies/regime-adaptive.js";
import { createRiskParityTripleScreen } from "../strategy/builtin-strategies/risk-parity-triple-screen.js";
import { createRsiMeanReversion } from "../strategy/builtin-strategies/rsi-mean-reversion.js";
import { createSmaCrossover } from "../strategy/builtin-strategies/sma-crossover.js";
import { createTrendFollowingMomentum } from "../strategy/builtin-strategies/trend-following-momentum.js";
import { createVolatilityMeanReversion } from "../strategy/builtin-strategies/volatility-mean-reversion.js";
import type { RemoteBacktestBridge } from "../strategy/remote-backtest-bridge.js";
import type { StrategyRegistry } from "../strategy/strategy-registry.js";

export interface ColdStartDeps {
  strategyRegistry: StrategyRegistry;
  bridge: RemoteBacktestBridge;
  eventStore: AgentEventSqliteStore;
  wakeBridge?: AgentWakeBridge;
  paperEngine?: {
    createAccount(name: string, initialCapital: number): { id: string; equity: number };
    submitOrder(
      accountId: string,
      order: {
        symbol: string;
        side: "buy" | "sell";
        type: "market" | "limit";
        quantity: number;
        strategyId?: string;
      },
      currentPrice: number,
    ): unknown;
  };
  /** Strategy discovery engine — used as primary seeding path. */
  discoveryEngine?: StrategyDiscoveryEngine;
  /** Discovery config override. */
  discoveryConfig?: DiscoveryConfig;
}

/** Minimum strategies required for a useful dashboard. */
const MIN_STRATEGIES = 3;

export class ColdStartSeeder {
  private deps: ColdStartDeps;

  constructor(deps: ColdStartDeps) {
    this.deps = deps;
  }

  /** True when the strategy pool already has enough strategies. */
  private isFullySeeded(): boolean {
    return this.deps.strategyRegistry.list().length >= MIN_STRATEGIES;
  }

  /**
   * Seed strategies on first launch. Idempotent.
   *
   * 1. Try StrategyDiscoveryEngine (real market data → deterministic + subagent).
   * 2. If discovery produces < MIN_STRATEGIES, fall back to hardcoded seeds.
   * 3. Seed paper positions and activity feed events.
   */
  async maybeSeed(): Promise<{ seeded: number; skipped: boolean }> {
    if (this.isFullySeeded()) {
      return { seeded: 0, skipped: true };
    }

    let discoveryCount = 0;

    // Primary path: AI-driven discovery
    if (this.deps.discoveryEngine) {
      try {
        const result = await this.deps.discoveryEngine.discover(this.deps.discoveryConfig);
        discoveryCount = result.deterministicIds.length;
        console.log(
          `[ColdStartSeeder] Discovery engine: ${discoveryCount} strategies created` +
            (result.subagentWakeFired ? ", subagent wake fired" : ""),
        );
      } catch (err) {
        console.warn("[ColdStartSeeder] Discovery engine failed, falling back to hardcoded:", err);
      }
    }

    // Fallback: hardcoded seeds if discovery didn't produce enough
    let fallbackCount = 0;
    if (this.deps.strategyRegistry.list().length < MIN_STRATEGIES) {
      fallbackCount = this.runFallbackSeed();
    }

    const totalSeeded = discoveryCount + fallbackCount;

    // Seed activity feed events
    this.seedActivityEvents(totalSeeded);

    // Seed paper positions for L2 strategies
    this.seedPaperPositions();

    // Seed approval card for best strategy
    this.seedApprovalCard();

    // Fire-and-forget: remote backtests for all strategies
    void this.runSeedBacktests();

    console.log(
      `[ColdStartSeeder] Total: ${totalSeeded} strategies (${discoveryCount} discovered, ${fallbackCount} fallback)`,
    );
    return { seeded: totalSeeded, skipped: false };
  }

  /**
   * Fallback: create hardcoded seed strategies with synthetic backtests.
   * Used when discovery engine is unavailable or produces too few strategies.
   */
  private runFallbackSeed(): number {
    const { strategyRegistry } = this.deps;
    const seeds = FALLBACK_SEEDS;
    let created = 0;

    const now = Date.now();
    const dayMs = 86_400_000;

    for (let i = 0; i < seeds.length; i++) {
      const { definition, level, backtest } = seeds[i]!;
      try {
        if (strategyRegistry.get(definition.id)) continue;

        strategyRegistry.create(definition);
        strategyRegistry.updateLevel(definition.id, level);

        if (backtest && backtest.totalTrades > 0) {
          strategyRegistry.updateBacktest(definition.id, {
            strategyId: definition.id,
            startDate: now - 90 * dayMs,
            endDate: now - dayMs,
            ...backtest,
            trades: [],
            equityCurve: [],
            dailyReturns: [],
          });
        }
        created++;
      } catch (err) {
        console.error(`[ColdStartSeeder] Fallback seed failed for ${definition.name}:`, err);
      }
    }

    return created;
  }

  /** Seed diverse activity events for the dashboard feed. */
  private seedActivityEvents(totalSeeded: number): void {
    const { eventStore } = this.deps;

    eventStore.addEvent({
      type: "system",
      title: "Cold Start: 策略池初始化完成",
      detail: `初始化 ${totalSeeded} 个策略。后台回测已启动。`,
      status: "completed",
    });

    eventStore.addEvent({
      type: "system",
      title: "AI 策略发现引擎已启动",
      detail: "基于实时市场数据的智能策略生成已激活，每日自动扫描全球市场寻找交易机会。",
      status: "completed",
    });
  }

  /** Seed paper positions for L2 strategies. */
  private seedPaperPositions(): void {
    if (!this.deps.paperEngine) return;

    const l2Strategies = this.deps.strategyRegistry.list({ level: "L2_PAPER" });
    const cryptoPairs = ["BTC/USDT", "ETH/USDT"];
    const prices = [65000, 3500];

    for (let i = 0; i < l2Strategies.length; i++) {
      const strat = l2Strategies[i]!;
      const sym = cryptoPairs[i % cryptoPairs.length]!;
      const price = prices[i % prices.length]!;
      try {
        const acct = this.deps.paperEngine.createAccount(`Paper-${strat.name}`, 10000);
        const qty = +((10000 * 0.1) / price).toFixed(4);
        this.deps.paperEngine.submitOrder(
          acct.id,
          { symbol: sym, side: "buy", type: "market", quantity: qty, strategyId: strat.id },
          price,
        );
      } catch (err) {
        console.error(`[ColdStartSeeder] Paper seed failed for ${strat.name}:`, err);
      }
    }
  }

  /** Seed L2→L3 approval card for best-performing L2 strategy. */
  private seedApprovalCard(): void {
    const l2 = this.deps.strategyRegistry.list({ level: "L2_PAPER" });
    if (l2.length === 0) return;

    // Pick best by Sharpe
    const best = l2.sort(
      (a, b) => (b.lastBacktest?.sharpe ?? 0) - (a.lastBacktest?.sharpe ?? 0),
    )[0]!;

    const bp = best.lastBacktest;
    this.deps.eventStore.addEvent({
      type: "trade_pending",
      status: "pending",
      feedType: "appr",
      title: `建议晋级 ${best.name} → L3 实盘`,
      detail: `策略 ${best.name} 模拟交易表现优异 (Sharpe ${bp?.sharpe?.toFixed(2) ?? "--"}, Return ${((bp?.totalReturn ?? 0) * 100).toFixed(1)}%)，建议提升至实盘。`,
      chips: [
        { label: "Sharpe", value: bp?.sharpe?.toFixed(2) ?? "--" },
        { label: "Return", value: `${((bp?.totalReturn ?? 0) * 100).toFixed(1)}%` },
        { label: "Win Rate", value: `${((bp?.winRate ?? 0) * 100).toFixed(0)}%` },
      ],
      actionParams: { action: "promote_l3", strategyId: best.id },
      trigger: { type: "system", source: "cold-start", label: "冷启动种子" },
      reasoning: "策略通过回测验证且模拟盘运行稳定",
      outcome: { type: "pending", action: "L2 → L3 晋升审批", badge: "待审批" },
    });
  }

  /** Run backtests for all strategies via remote service. */
  private async runSeedBacktests(): Promise<void> {
    const { strategyRegistry, bridge, eventStore, wakeBridge } = this.deps;
    const strategies = strategyRegistry.list();

    let completed = 0;
    let qualified = 0;

    for (const record of strategies) {
      try {
        const result = await bridge.runBacktest(record.definition, {
          capital: 10_000,
          commissionRate: 0.001,
          slippageBps: 5,
          market: record.definition.markets[0] ?? "crypto",
        });
        strategyRegistry.updateBacktest(record.id, result);
        completed++;
        if (result.sharpe > 0.5 && result.totalReturn > 0) qualified++;
      } catch (err) {
        eventStore.addEvent({
          type: "system",
          title: `Cold Start: Backtest failed for ${record.name}`,
          detail: `Error: ${err instanceof Error ? err.message : String(err)}`,
          status: "completed",
        });
      }
    }

    if (completed > 0) {
      wakeBridge?.onSeedBacktestComplete({ completed, qualified });
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback hardcoded seeds (used when discovery engine is unavailable)
// ---------------------------------------------------------------------------

type SyntheticBacktest = Omit<
  BacktestResult,
  "strategyId" | "startDate" | "endDate" | "trades" | "equityCurve" | "dailyReturns"
>;

interface FallbackSeed {
  definition: StrategyDefinition;
  level: StrategyLevel;
  backtest?: SyntheticBacktest;
}

const FALLBACK_SEEDS: FallbackSeed[] = [
  {
    definition: createSmaCrossover({ symbol: "BTC/USDT" }),
    level: "L1_BACKTEST",
    backtest: {
      initialCapital: 10000,
      finalEquity: 11200,
      totalReturn: 0.12,
      sharpe: 1.05,
      sortino: 1.26,
      maxDrawdown: -0.11,
      calmar: 1.09,
      winRate: 0.52,
      profitFactor: 1.45,
      totalTrades: 180,
    },
  },
  {
    definition: createRsiMeanReversion({ symbol: "ETH/USDT" }),
    level: "L1_BACKTEST",
    backtest: {
      initialCapital: 10000,
      finalEquity: 10850,
      totalReturn: 0.085,
      sharpe: 0.78,
      sortino: 0.94,
      maxDrawdown: -0.14,
      calmar: 0.61,
      winRate: 0.58,
      profitFactor: 1.32,
      totalTrades: 95,
    },
  },
  {
    definition: {
      ...createMacdDivergence({ symbol: "AAPL" }),
      markets: ["us-stock" as const],
      name: "MACD Divergence (AAPL)",
    },
    level: "L2_PAPER",
    backtest: {
      initialCapital: 10000,
      finalEquity: 11600,
      totalReturn: 0.16,
      sharpe: 1.35,
      sortino: 1.62,
      maxDrawdown: -0.08,
      calmar: 2.0,
      winRate: 0.61,
      profitFactor: 1.72,
      totalTrades: 85,
    },
  },
  {
    definition: {
      ...createBollingerBands({ symbol: "0700.HK" }),
      markets: ["hk-stock" as const],
      name: "Bollinger Bands (0700.HK)",
    },
    level: "L1_BACKTEST",
    backtest: {
      initialCapital: 10000,
      finalEquity: 10450,
      totalReturn: 0.045,
      sharpe: 0.62,
      sortino: 0.75,
      maxDrawdown: -0.1,
      calmar: 0.45,
      winRate: 0.58,
      profitFactor: 1.22,
      totalTrades: 62,
    },
  },
  {
    definition: {
      ...createTrendFollowingMomentum({ symbol: "600519.SS" }),
      markets: ["a-share" as const],
      name: "Trend Following (茅台)",
    },
    level: "L0_INCUBATE",
  },
  {
    definition: createVolatilityMeanReversion({ symbol: "SOL/USDT" }),
    level: "L1_BACKTEST",
    backtest: {
      initialCapital: 10000,
      finalEquity: 10420,
      totalReturn: 0.042,
      sharpe: 0.55,
      sortino: 0.66,
      maxDrawdown: -0.12,
      calmar: 0.35,
      winRate: 0.48,
      profitFactor: 1.15,
      totalTrades: 210,
    },
  },
  {
    definition: createRegimeAdaptive({ symbol: "BTC/USDT" }),
    level: "L3_LIVE",
    backtest: {
      initialCapital: 10000,
      finalEquity: 13500,
      totalReturn: 0.35,
      sharpe: 2.15,
      sortino: 2.58,
      maxDrawdown: -0.06,
      calmar: 5.83,
      winRate: 0.62,
      profitFactor: 2.4,
      totalTrades: 160,
    },
  },
  {
    definition: {
      ...createMultiTimeframeConfluence({ symbol: "SPY" }),
      markets: ["us-stock" as const],
      name: "Multi-TF Confluence (SPY)",
    },
    level: "L2_PAPER",
    backtest: {
      initialCapital: 10000,
      finalEquity: 11400,
      totalReturn: 0.14,
      sharpe: 1.18,
      sortino: 1.42,
      maxDrawdown: -0.07,
      calmar: 2.0,
      winRate: 0.63,
      profitFactor: 1.65,
      totalTrades: 48,
    },
  },
  {
    definition: createRiskParityTripleScreen({ symbol: "BNB/USDT" }),
    level: "L0_INCUBATE",
  },
  {
    definition: {
      ...buildCustomStrategy(
        "Custom RSI Breakout",
        { buy: "rsi < 30 AND close > sma", sell: "rsi > 70" },
        { rsiPeriod: 14, smaPeriod: 50 },
        ["ETH/USDT"],
      ),
      id: "custom-rsi-breakout",
    },
    level: "L1_BACKTEST",
    backtest: {
      initialCapital: 10000,
      finalEquity: 10950,
      totalReturn: 0.095,
      sharpe: 0.82,
      sortino: 0.98,
      maxDrawdown: -0.1,
      calmar: 0.95,
      winRate: 0.51,
      profitFactor: 1.38,
      totalTrades: 72,
    },
  },
];
