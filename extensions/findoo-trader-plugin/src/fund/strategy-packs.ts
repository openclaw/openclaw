import type { StrategyDefinition } from "../shared/types.js";
import { createBollingerBands } from "../strategy/builtin-strategies/bollinger-bands.js";
import { createMacdDivergence } from "../strategy/builtin-strategies/macd-divergence.js";
import { createRsiMeanReversion } from "../strategy/builtin-strategies/rsi-mean-reversion.js";
import { createSmaCrossover } from "../strategy/builtin-strategies/sma-crossover.js";
import { createTrendFollowingMomentum } from "../strategy/builtin-strategies/trend-following-momentum.js";
import { createVolatilityMeanReversion } from "../strategy/builtin-strategies/volatility-mean-reversion.js";

export type StrategyPack = {
  id: string;
  name: string;
  description: string;
  category: "starter" | "momentum" | "conservative";
  strategies: StrategyDefinition[];
};

/** Prefix a strategy ID to avoid collisions when deploying from a pack. */
function prefixed(def: StrategyDefinition, packId: string): StrategyDefinition {
  return { ...def, id: `${packId}--${def.id}`, name: `[${packId}] ${def.name}` };
}

export const STRATEGY_PACKS: StrategyPack[] = [
  {
    id: "crypto-starter",
    name: "Crypto Starter Pack",
    description:
      "Balanced mix of trend-following and mean-reversion on BTC/ETH. Great for beginners.",
    category: "starter",
    strategies: [
      prefixed(createSmaCrossover({ symbol: "BTC/USDT" }), "crypto-starter"),
      prefixed(createRsiMeanReversion({ symbol: "BTC/USDT" }), "crypto-starter"),
      prefixed(createBollingerBands({ symbol: "ETH/USDT" }), "crypto-starter"),
    ],
  },
  {
    id: "momentum-pack",
    name: "Momentum Pack",
    description: "Aggressive momentum strategies. Higher risk, higher reward potential.",
    category: "momentum",
    strategies: [
      prefixed(createMacdDivergence({ symbol: "BTC/USDT" }), "momentum-pack"),
      prefixed(createTrendFollowingMomentum({ symbol: "ETH/USDT" }), "momentum-pack"),
      prefixed(
        createSmaCrossover({ symbol: "ETH/USDT", fastPeriod: 20, slowPeriod: 50 }),
        "momentum-pack",
      ),
    ],
  },
  {
    id: "conservative-pack",
    name: "Conservative Pack",
    description: "Low-volatility mean-reversion strategies with tight risk controls.",
    category: "conservative",
    strategies: [
      prefixed(createVolatilityMeanReversion({ symbol: "BTC/USDT" }), "conservative-pack"),
      prefixed(
        createRsiMeanReversion({ symbol: "ETH/USDT", period: 21, oversold: 25, overbought: 75 }),
        "conservative-pack",
      ),
      prefixed(
        createBollingerBands({ symbol: "BTC/USDT", period: 30, stdDev: 2.5 }),
        "conservative-pack",
      ),
    ],
  },
];

export function getStrategyPack(id: string): StrategyPack | undefined {
  return STRATEGY_PACKS.find((p) => p.id === id);
}
