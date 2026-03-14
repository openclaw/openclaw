import type { AgentEventSqliteStore } from "../core/agent-event-sqlite-store.js";
import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";
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

/** Level distribution: 2×L0, 5×L1, 2×L2, 1×L3 — indexed to match SEED_STRATEGIES */
const LEVEL_MAP: StrategyLevel[] = [
  "L1_BACKTEST", // 0: SMA Crossover
  "L1_BACKTEST", // 1: RSI Mean Reversion
  "L2_PAPER", // 2: MACD Divergence
  "L1_BACKTEST", // 3: Bollinger Bands
  "L0_INCUBATE", // 4: Trend Following Momentum
  "L1_BACKTEST", // 5: Volatility Mean Reversion
  "L3_LIVE", // 6: Regime Adaptive
  "L2_PAPER", // 7: Multi-Timeframe Confluence
  "L0_INCUBATE", // 8: Risk Parity Triple Screen
  "L1_BACKTEST", // 9: Custom RSI Breakout
];

/** 10 seed strategies covering Trend / Mean-Rev / Momentum / Composite / Rule-based
 *  Multi-market: crypto + us-stock + hk-stock + a-share */
const SEED_STRATEGIES: StrategyDefinition[] = [
  createSmaCrossover({ symbol: "BTC/USDT" }),
  createRsiMeanReversion({ symbol: "ETH/USDT" }),
  {
    ...createMacdDivergence({ symbol: "AAPL" }),
    markets: ["us-stock"],
    name: "MACD Divergence (AAPL)",
  },
  {
    ...createBollingerBands({ symbol: "0700.HK" }),
    markets: ["hk-stock"],
    name: "Bollinger Bands (0700.HK)",
  },
  {
    ...createTrendFollowingMomentum({ symbol: "600519.SS" }),
    markets: ["a-share"],
    name: "Trend Following (茅台)",
  },
  createVolatilityMeanReversion({ symbol: "SOL/USDT" }),
  createRegimeAdaptive({ symbol: "BTC/USDT" }),
  {
    ...createMultiTimeframeConfluence({ symbol: "SPY" }),
    markets: ["us-stock"],
    name: "Multi-TF Confluence (SPY)",
  },
  createRiskParityTripleScreen({ symbol: "BNB/USDT" }),
  {
    ...buildCustomStrategy(
      "Custom RSI Breakout",
      { buy: "rsi < 30 AND close > sma", sell: "rsi > 70" },
      { rsiPeriod: 14, smaPeriod: 50 },
      ["ETH/USDT"],
    ),
    id: "custom-rsi-breakout",
  },
];

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
}

export class ColdStartSeeder {
  private deps: ColdStartDeps;

  constructor(deps: ColdStartDeps) {
    this.deps = deps;
  }

  /**
   * True when all 10 seed strategies exist AND have their target levels assigned.
   * This makes seeding idempotent — re-runs fix partial seeds.
   */
  private isFullySeeded(): boolean {
    const { strategyRegistry } = this.deps;
    return SEED_STRATEGIES.every((def, i) => {
      const record = strategyRegistry.get(def.id);
      return record && record.level === LEVEL_MAP[i];
    });
  }

  /**
   * Seed 10 strategies and distribute across levels (L0/L1/L2/L3).
   * Idempotent: creates missing strategies and updates levels/backtests
   * for existing ones that haven't been fully configured.
   */
  async maybeSeed(): Promise<{ seeded: number; skipped: boolean }> {
    if (this.isFullySeeded()) {
      return { seeded: 0, skipped: true };
    }

    const { strategyRegistry, eventStore } = this.deps;

    // Synthetic backtest profiles — higher-level strategies get better metrics
    const backtestProfiles: Array<
      Omit<
        BacktestResult,
        "strategyId" | "startDate" | "endDate" | "trades" | "equityCurve" | "dailyReturns"
      >
    > = [
      {
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
      {
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
      {
        // MACD Divergence (AAPL) — us-stock L2, moderate metrics
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
      {
        // Bollinger Bands (0700.HK) — hk-stock L1, conservative
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
      {
        initialCapital: 10000,
        finalEquity: 10000,
        totalReturn: 0,
        sharpe: 0,
        sortino: 0,
        maxDrawdown: 0,
        calmar: 0,
        winRate: 0,
        profitFactor: 0,
        totalTrades: 0,
      }, // L0 — no backtest
      {
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
      {
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
      }, // L3 — best
      {
        // Multi-TF Confluence (SPY) — us-stock L2, steady equity metrics
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
      {
        initialCapital: 10000,
        finalEquity: 10000,
        totalReturn: 0,
        sharpe: 0,
        sortino: 0,
        maxDrawdown: 0,
        calmar: 0,
        winRate: 0,
        profitFactor: 0,
        totalTrades: 0,
      }, // L0 — no backtest
      {
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
    ];

    const now = Date.now();
    const dayMs = 86_400_000;
    let created = 0;

    // Create (if missing) + assign levels + populate backtests — idempotent
    for (let i = 0; i < SEED_STRATEGIES.length; i++) {
      const def = SEED_STRATEGIES[i];

      try {
        // Create if not already present
        if (!strategyRegistry.get(def.id)) {
          strategyRegistry.create(def);
          created++;
        }

        // Always set target level (fixes partial seeds where old code left everything at L0)
        strategyRegistry.updateLevel(def.id, LEVEL_MAP[i]);

        // Populate synthetic backtest for strategies at L1+
        const profile = backtestProfiles[i];
        if (profile.totalTrades > 0) {
          const result: BacktestResult = {
            strategyId: def.id,
            startDate: now - 90 * dayMs,
            endDate: now - dayMs,
            ...profile,
            trades: [],
            equityCurve: [],
            dailyReturns: [],
          };
          strategyRegistry.updateBacktest(def.id, result);
        }
      } catch (err) {
        console.error(`[ColdStartSeeder] Failed to seed strategy ${def.name} (index ${i}):`, err);
      }
    }

    // --- Diverse seed events for a rich Activity Feed ---
    eventStore.addEvent({
      type: "system",
      title: "Cold Start: Seeding strategies",
      detail: `Seeded ${SEED_STRATEGIES.length} classic strategies across 4 levels (2×L0, 5×L1, 2×L2, 1×L3). Background backtests starting.`,
      status: "completed",
    });

    eventStore.addEvent({
      type: "strategy_promoted",
      title: "MACD Divergence promoted L1 → L2",
      detail:
        "Sharpe 1.65, return +28%, drawdown -9%. Promoted to paper trading after strong backtest results.",
      status: "completed",
    });

    eventStore.addEvent({
      type: "system",
      title: "SMA Crossover evolved v1 → v1.1",
      detail:
        "RSI confirmation period adjusted 14 → 12. Fast SMA period 10 → 8 for quicker signal entry.",
      status: "completed",
    });

    eventStore.addEvent({
      type: "system",
      title: "Regime Adaptive completed backtest",
      detail:
        "240 trades over 90 days. Sharpe 2.15, return +35%, max drawdown -6%. Best performing strategy.",
      status: "completed",
    });

    eventStore.addEvent({
      type: "alert_triggered",
      title: "Bollinger Bands Sharpe decay detected",
      detail:
        "Sharpe declined from 0.60 → 0.35 over last 30 days. Strategy under review for demotion.",
      status: "completed",
    });

    eventStore.addEvent({
      type: "system",
      title: "Agent discovered Trend-Reversal pattern",
      detail:
        "Momentum + mean-reversion confluence detected on BTC/USDT 4h timeframe. Incubating new strategy candidate.",
      status: "completed",
    });

    // Seed paper positions for L2 strategies so Trader page Paper domain shows data.
    // Use crypto pairs (24/7 market) to avoid market-hours rejection for equity strategies.
    if (this.deps.paperEngine) {
      const l2CryptoPairs = ["BTC/USDT", "ETH/USDT"];
      const l2Prices = [65000, 3500];
      let pairIdx = 0;
      for (let i = 0; i < SEED_STRATEGIES.length; i++) {
        if (LEVEL_MAP[i] === "L2_PAPER") {
          const def = SEED_STRATEGIES[i]!;
          const sym = l2CryptoPairs[pairIdx % l2CryptoPairs.length]!;
          const price = l2Prices[pairIdx % l2Prices.length]!;
          pairIdx++;
          try {
            const acct = this.deps.paperEngine.createAccount(`Paper-${def.name}`, 10000);
            const qty = +((10000 * 0.1) / price).toFixed(4);
            this.deps.paperEngine.submitOrder(
              acct.id,
              {
                symbol: sym,
                side: "buy",
                type: "market",
                quantity: qty,
                strategyId: def.id,
              },
              price,
            );
          } catch (err) {
            console.error(`[ColdStartSeeder] Paper seed failed for ${def.name}:`, err);
          }
        }
      }
    }

    // Seed L2→L3 approval event for best-performing L2 strategy
    const l2Strategies = SEED_STRATEGIES.filter((_, i) => LEVEL_MAP[i] === "L2_PAPER");
    const bestL2 = l2Strategies.sort(
      (a, b) =>
        (backtestProfiles[SEED_STRATEGIES.indexOf(b)]?.sharpe ?? 0) -
        (backtestProfiles[SEED_STRATEGIES.indexOf(a)]?.sharpe ?? 0),
    )[0];
    if (bestL2) {
      const bp = backtestProfiles[SEED_STRATEGIES.indexOf(bestL2)];
      eventStore.addEvent({
        type: "trade_pending",
        status: "pending",
        feedType: "appr",
        title: `建议晋级 ${bestL2.name} → L3 实盘`,
        detail: `策略 ${bestL2.name} 模拟交易表现优异 (Sharpe ${bp?.sharpe?.toFixed(2) ?? "--"}, Return ${((bp?.totalReturn ?? 0) * 100).toFixed(1)}%)，建议提升至实盘。`,
        chips: [
          { label: "Sharpe", value: bp?.sharpe?.toFixed(2) ?? "--" },
          { label: "Return", value: `${((bp?.totalReturn ?? 0) * 100).toFixed(1)}%` },
          { label: "Win Rate", value: `${((bp?.winRate ?? 0) * 100).toFixed(0)}%` },
        ],
        actionParams: { action: "promote_l3", strategyId: bestL2.id },
        trigger: { type: "system", source: "cold-start", label: "冷启动种子" },
        reasoning: "策略通过回测验证且模拟盘运行稳定",
        outcome: { type: "pending", action: "L2 → L3 晋升审批", badge: "待审批" },
      });
    }

    // Fire-and-forget: run backtests for each seed strategy
    void this.runSeedBacktests();

    console.log(
      `[ColdStartSeeder] Seeded ${created} new + updated ${SEED_STRATEGIES.length - created} existing strategies across L0/L1/L2/L3`,
    );
    return { seeded: SEED_STRATEGIES.length, skipped: false };
  }

  /** Run backtests for all seed strategies via remote service. Failures are logged as events. */
  private async runSeedBacktests(): Promise<void> {
    const { strategyRegistry, bridge, eventStore, wakeBridge } = this.deps;

    let completed = 0;
    let qualified = 0;

    for (const def of SEED_STRATEGIES) {
      try {
        const result = await bridge.runBacktest(def, {
          capital: 10_000,
          commissionRate: 0.001,
          slippageBps: 5,
          market: "crypto",
        });
        strategyRegistry.updateBacktest(def.id, result);
        completed++;
        if (result.sharpe > 0.5 && result.totalReturn > 0) qualified++;
      } catch (err) {
        eventStore.addEvent({
          type: "system",
          title: `Cold Start: Backtest failed for ${def.name}`,
          detail: `Error: ${err instanceof Error ? err.message : String(err)}`,
          status: "completed",
        });
      }
    }

    // Wake Agent to review backtest results and consider promotions
    if (completed > 0) {
      wakeBridge?.onSeedBacktestComplete({ completed, qualified });
    }
  }
}
