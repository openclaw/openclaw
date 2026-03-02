/**
 * Data gathering functions that aggregate state from multiple fin-* services
 * for dashboard rendering and API responses.
 */

import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import type { ExchangeRegistry } from "./exchange-registry.js";
import type {
  AlertEngineLike,
  FundManagerLike,
  PaperEngineLike,
  RuntimeServices,
  StrategyRegistryLike,
} from "./types-http.js";
import type { TradingRiskConfig } from "./types.js";

const FINANCIAL_PLUGIN_IDS = [
  "fin-core",
  "findoo-datahub-plugin",
  "fin-market-data",
  "fin-trading",
  "fin-portfolio",
  "fin-monitoring",
  "fin-paper-trading",
  "fin-strategy-engine",
  "fin-strategy-memory",
  "fin-fund-manager",
  "fin-expert-sdk",
  "fin-info-feed",
] as const;

export type DataGatheringDeps = {
  registry: ExchangeRegistry;
  riskConfig: TradingRiskConfig;
  eventStore: AgentEventSqliteStore;
  runtime: RuntimeServices;
  pluginEntries: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
};

/** Gather finance configuration overview (exchanges, trading limits, plugin status). */
export function gatherFinanceConfigData(deps: DataGatheringDeps) {
  const { registry, riskConfig, pluginEntries } = deps;

  const plugins = FINANCIAL_PLUGIN_IDS.map((id) => ({
    id,
    enabled: pluginEntries[id]?.enabled === true,
  }));

  return {
    generatedAt: new Date().toISOString(),
    exchanges: registry.listExchanges(),
    trading: {
      enabled: riskConfig.enabled,
      maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
      confirmThresholdUsd: riskConfig.confirmThresholdUsd,
      maxDailyLossUsd: riskConfig.maxDailyLossUsd,
      maxPositionPct: riskConfig.maxPositionPct,
      maxLeverage: riskConfig.maxLeverage,
      allowedPairs: riskConfig.allowedPairs ?? [],
      blockedPairs: riskConfig.blockedPairs ?? [],
    },
    plugins: {
      total: plugins.length,
      enabled: plugins.filter((entry) => entry.enabled).length,
      entries: plugins,
    },
  };
}

/** Gather full trading pipeline data (accounts, positions, orders, strategies, allocations). */
export function gatherTradingData(deps: DataGatheringDeps) {
  const { runtime } = deps;

  const paperEngine = runtime.services?.get?.("fin-paper-engine") as PaperEngineLike | undefined;
  const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
    | StrategyRegistryLike
    | undefined;
  const fundManager = runtime.services?.get?.("fin-fund-manager") as FundManagerLike | undefined;

  // Aggregate across all paper accounts
  const accounts = paperEngine?.listAccounts() ?? [];
  let totalEquity = 0;
  let totalDailyPnl = 0;
  const allPositions: Array<Record<string, unknown>> = [];
  const allOrders: Array<Record<string, unknown>> = [];
  const allSnapshots: Array<Record<string, unknown>> = [];

  for (const acct of accounts) {
    const state = paperEngine?.getAccountState(acct.id);
    if (!state) continue;

    totalEquity += state.equity;

    for (const pos of state.positions) {
      allPositions.push(pos);
    }

    const snapshots = paperEngine?.getSnapshots(acct.id) ?? [];
    for (const snap of snapshots) {
      allSnapshots.push(snap);
    }
    if (snapshots.length > 0) {
      totalDailyPnl += snapshots[snapshots.length - 1]!.dailyPnl;
    }

    const orders = paperEngine?.getOrders(acct.id, 50) ?? [];
    for (const order of orders) {
      allOrders.push(order);
    }
  }

  // Strategies
  const strategies = strategyRegistry?.list() ?? [];
  const strategyData = strategies.map((s) => ({
    id: s.id,
    name: s.name,
    level: s.level,
    totalReturn: s.lastBacktest?.totalReturn,
    sharpe: s.lastBacktest?.sharpe,
    maxDrawdown: s.lastBacktest?.maxDrawdown,
    totalTrades: s.lastBacktest?.totalTrades,
  }));

  // Backtests
  const backtests = strategies.filter((s) => s.lastBacktest).map((s) => s.lastBacktest!);

  // Allocations
  const fundState = fundManager?.getState();
  const allocItems = fundState?.allocations ?? [];
  const totalAllocated = allocItems.reduce(
    (sum: number, a: { capitalUsd: number }) => sum + a.capitalUsd,
    0,
  );

  // Win rate from filled round-trip trades (FIFO pairing of buy->sell)
  const filledOrders = allOrders
    .filter((o) => (o as { status: string }).status === "filled")
    .sort(
      (a, b) =>
        ((a as { filledAt?: number }).filledAt ?? 0) - ((b as { filledAt?: number }).filledAt ?? 0),
    );
  let winRate: number | null = null;
  {
    const grouped = new Map<string, { buys: number[]; sells: number[] }>();
    for (const o of filledOrders) {
      const rec = o as {
        accountId?: string;
        symbol?: string;
        side?: string;
        fillPrice?: number;
      };
      const key = `${rec.accountId}:${rec.symbol}`;
      if (!grouped.has(key)) grouped.set(key, { buys: [], sells: [] });
      const g = grouped.get(key)!;
      if (rec.side === "buy" && rec.fillPrice != null) g.buys.push(rec.fillPrice);
      if (rec.side === "sell" && rec.fillPrice != null) g.sells.push(rec.fillPrice);
    }
    let wins = 0;
    let trips = 0;
    for (const [, g] of grouped) {
      const pairs = Math.min(g.buys.length, g.sells.length);
      for (let i = 0; i < pairs; i++) {
        trips++;
        if (g.sells[i]! > g.buys[i]!) wins++;
      }
    }
    if (trips > 0) winRate = wins / trips;
  }
  const totalInitialCapital =
    accounts.length > 0 ? accounts.reduce((sum, a) => sum + a.equity, 0) : totalEquity;
  const dailyPnlPct = totalInitialCapital > 0 ? (totalDailyPnl / totalInitialCapital) * 100 : 0;

  // Avg sharpe from strategies with backtests
  const sharpValues = strategies
    .filter((s) => s.lastBacktest?.sharpe != null)
    .map((s) => s.lastBacktest!.sharpe);
  const avgSharpe =
    sharpValues.length > 0 ? sharpValues.reduce((a, b) => a + b, 0) / sharpValues.length : null;

  // Sort snapshots by timestamp for equity curve
  allSnapshots.sort(
    (a, b) => (a as { timestamp: number }).timestamp - (b as { timestamp: number }).timestamp,
  );

  return {
    summary: {
      totalEquity,
      dailyPnl: totalDailyPnl,
      dailyPnlPct,
      positionCount: allPositions.length,
      strategyCount: strategies.length,
      winRate,
      avgSharpe,
    },
    positions: allPositions,
    orders: allOrders,
    snapshots: allSnapshots,
    strategies: strategyData,
    backtests,
    allocations: {
      items: allocItems,
      totalAllocated,
      cashReserve: (fundState?.totalCapital ?? 0) - totalAllocated,
      totalCapital: fundState?.totalCapital ?? 0,
    },
  };
}

/** Gather command center data (trading + events + alerts + risk overview). */
export function gatherCommandCenterData(deps: DataGatheringDeps) {
  const { runtime, eventStore, riskConfig } = deps;

  const trading = gatherTradingData(deps);
  const events = {
    events: eventStore.listEvents(),
    pendingCount: eventStore.pendingCount(),
  };

  const alertEngine = runtime.services?.get?.("fin-alert-engine") as AlertEngineLike | undefined;
  const alerts = alertEngine?.listAlerts() ?? [];

  return {
    trading,
    events,
    alerts,
    risk: {
      enabled: riskConfig.enabled,
      maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
      confirmThresholdUsd: riskConfig.confirmThresholdUsd,
      maxDailyLossUsd: riskConfig.maxDailyLossUsd,
    },
  };
}

/** Gather mission control data (command center + fund state). */
export function gatherMissionControlData(deps: DataGatheringDeps) {
  const { runtime, eventStore, riskConfig } = deps;

  const trading = gatherTradingData(deps);
  const events = {
    events: eventStore.listEvents(),
    pendingCount: eventStore.pendingCount(),
  };

  const alertEngine = runtime.services?.get?.("fin-alert-engine") as AlertEngineLike | undefined;
  const alerts = alertEngine?.listAlerts() ?? [];

  const fundManager = runtime.services?.get?.("fin-fund-manager") as FundManagerLike | undefined;
  const fundState = fundManager?.getState?.() ?? {
    allocations: [],
    totalCapital: 0,
  };

  return {
    trading,
    events,
    alerts,
    risk: {
      enabled: riskConfig.enabled,
      maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
      confirmThresholdUsd: riskConfig.confirmThresholdUsd,
      maxDailyLossUsd: riskConfig.maxDailyLossUsd,
    },
    fund: fundState,
  };
}
