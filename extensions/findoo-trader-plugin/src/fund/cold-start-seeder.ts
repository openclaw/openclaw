import type { AgentEventSqliteStore } from "../core/agent-event-sqlite-store.js";
import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";
import type { StrategyDefinition } from "../shared/types.js";
import { createBollingerBands } from "../strategy/builtin-strategies/bollinger-bands.js";
import { createMacdDivergence } from "../strategy/builtin-strategies/macd-divergence.js";
import { createRsiMeanReversion } from "../strategy/builtin-strategies/rsi-mean-reversion.js";
import { createSmaCrossover } from "../strategy/builtin-strategies/sma-crossover.js";
import { createTrendFollowingMomentum } from "../strategy/builtin-strategies/trend-following-momentum.js";
import type { RemoteBacktestBridge } from "../strategy/remote-backtest-bridge.js";
import type { StrategyRegistry } from "../strategy/strategy-registry.js";

/** 5 classic seed strategies covering Trend / Mean-Rev / Momentum */
const SEED_STRATEGIES: StrategyDefinition[] = [
  createSmaCrossover({ symbol: "BTC/USDT" }),
  createRsiMeanReversion({ symbol: "ETH/USDT" }),
  createMacdDivergence({ symbol: "BTC/USDT" }),
  createBollingerBands({ symbol: "ETH/USDT" }),
  createTrendFollowingMomentum({ symbol: "BTC/USDT" }),
];

export interface ColdStartDeps {
  strategyRegistry: StrategyRegistry;
  bridge: RemoteBacktestBridge;
  eventStore: AgentEventSqliteStore;
  wakeBridge?: AgentWakeBridge;
}

export class ColdStartSeeder {
  private deps: ColdStartDeps;

  constructor(deps: ColdStartDeps) {
    this.deps = deps;
  }

  /** True when the strategy registry has zero entries. */
  isEmpty(): boolean {
    return this.deps.strategyRegistry.list().length === 0;
  }

  /**
   * Seed 5 classic strategies if the registry is empty.
   * Creates at L0, auto-promotes to L1, then fires backtests in the background.
   */
  async maybeSeed(): Promise<{ seeded: number; skipped: boolean }> {
    if (!this.isEmpty()) {
      return { seeded: 0, skipped: true };
    }

    const { strategyRegistry, eventStore } = this.deps;

    // Create + promote each seed strategy
    for (const def of SEED_STRATEGIES) {
      // Skip if somehow already exists (idempotency guard)
      if (strategyRegistry.get(def.id)) continue;

      strategyRegistry.create(def);
      strategyRegistry.updateLevel(def.id, "L1_BACKTEST");
    }

    eventStore.addEvent({
      type: "system",
      title: "Cold Start: Seeding strategies",
      detail: `Seeded ${SEED_STRATEGIES.length} classic strategies (L1_BACKTEST). Background backtests starting.`,
      status: "completed",
    });

    // Fire-and-forget: run backtests for each seed strategy
    void this.runSeedBacktests();

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
