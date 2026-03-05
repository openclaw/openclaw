/**
 * Data gathering functions that aggregate state from multiple fin-* services
 * for dashboard rendering and API responses.
 */

import type { LiveExecutor } from "../execution/live-executor.js";
import type {
  AlertEngineLike,
  FundManagerLike,
  PaperEngineLike,
  RuntimeServices,
  StrategyRegistryLike,
} from "../types-http.js";
import type {
  AgentBehaviorConfig,
  NotificationConfig,
  PromotionGateConfig,
  TradingDomain,
  TradingRiskConfig,
} from "../types.js";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import type { ExchangeHealthStore } from "./exchange-health-store.js";
import type { ExchangeRegistry } from "./exchange-registry.js";

const FINANCIAL_PLUGIN_IDS = [
  "findoo-trader-plugin",
  "findoo-datahub-plugin",
  "findoo-backtest-plugin",
  "fin-evolution-engine",
] as const;

export type DataGatheringDeps = {
  registry: ExchangeRegistry;
  riskConfig: TradingRiskConfig;
  eventStore: AgentEventSqliteStore;
  runtime: RuntimeServices;
  pluginEntries: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
  liveExecutor?: LiveExecutor;
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

/** Gather overview data (mission control + finance config merged). */
export function gatherOverviewData(deps: DataGatheringDeps) {
  const mc = gatherMissionControlData(deps);
  const config = gatherFinanceConfigData(deps);
  return { ...mc, config };
}

/** Gather strategy lab data (strategies + backtests + fund allocations). */
export function gatherStrategyLabData(deps: DataGatheringDeps) {
  const { runtime } = deps;

  const trading = gatherTradingData(deps);

  const fundManager = runtime.services?.get?.("fin-fund-manager") as FundManagerLike | undefined;
  const fundState = fundManager?.getState?.() ?? {
    allocations: [],
    totalCapital: 0,
  };

  return {
    strategies: trading.strategies,
    backtests: trading.backtests,
    allocations: trading.allocations,
    fund: fundState,
    summary: trading.summary,
  };
}

// ── New gather functions for V2 dashboard tabs ──

/** Gather Setting Tab data (exchanges, health, risk config, agent config, gates, notifications). */
export function gatherSettingData(deps: DataGatheringDeps & { healthStore?: ExchangeHealthStore }) {
  const { registry, riskConfig, runtime, pluginEntries, healthStore } = deps;

  const exchanges = registry.listExchanges();
  const exchangeHealth = healthStore?.listAll() ?? [];

  // Agent behavior config from runtime service (or defaults)
  const agentConfigStore = runtime.services?.get?.("fin-agent-config") as
    | { get?: () => AgentBehaviorConfig }
    | undefined;
  const agent: AgentBehaviorConfig = agentConfigStore?.get?.() ?? {
    heartbeatIntervalMs: 60000,
    discoveryEnabled: true,
    evolutionEnabled: false,
    mutationRate: 0.1,
    maxConcurrentStrategies: 5,
  };

  // Promotion gates config from runtime service (or defaults)
  const gateConfigStore = runtime.services?.get?.("fin-gate-config") as
    | { get?: () => PromotionGateConfig }
    | undefined;
  const gates: PromotionGateConfig = gateConfigStore?.get?.() ?? {
    l0l1: { minDays: 7, minSharpe: 0.5, maxDrawdown: -0.2, minWinRate: 0.4, minTrades: 10 },
    l1l2: { minDays: 14, minSharpe: 1.0, maxDrawdown: -0.15, minWinRate: 0.45, minTrades: 30 },
    l2l3: { minDays: 30, minSharpe: 1.5, maxDrawdown: -0.1, minWinRate: 0.5, minTrades: 50 },
  };

  // Notification config (placeholder — no built-in notification service yet)
  const notifications: NotificationConfig = {
    telegram: { enabled: false },
    discord: { enabled: false },
    email: { enabled: false },
  };

  const plugins = FINANCIAL_PLUGIN_IDS.map((id) => ({
    id,
    enabled: pluginEntries[id]?.enabled === true,
  }));

  return {
    generatedAt: new Date().toISOString(),
    exchanges,
    exchangeHealth,
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
    agent,
    gates,
    notifications,
    onboarding: { completed: exchanges.length > 0 },
    plugins: {
      total: plugins.length,
      enabled: plugins.filter((entry) => entry.enabled).length,
      entries: plugins,
    },
  };
}

/** Gather live trading data from real exchanges via LiveExecutor. */
export async function gatherLiveTradingData(deps: DataGatheringDeps) {
  const { registry, liveExecutor } = deps;

  const emptyResult = {
    summary: {
      totalEquity: 0,
      dailyPnl: 0,
      dailyPnlPct: 0,
      positionCount: 0,
      exchangeCount: 0,
    },
    positions: [] as Array<Record<string, unknown>>,
    balances: [] as Array<Record<string, unknown>>,
    exchanges: [] as Array<{ id: string; exchange: string; status: string }>,
  };

  if (!liveExecutor) return emptyResult;

  const exchanges = registry.listExchanges();
  const allPositions: Array<Record<string, unknown>> = [];
  const allBalances: Array<Record<string, unknown>> = [];
  const exchangeStatuses: Array<{ id: string; exchange: string; status: string }> = [];
  let totalEquity = 0;

  for (const ex of exchanges) {
    let balance: Record<string, unknown> | undefined;
    let positions: unknown[] | undefined;

    try {
      balance = await liveExecutor.fetchBalance(ex.id);
    } catch {
      exchangeStatuses.push({ id: ex.id, exchange: ex.exchange, status: "error" });
      continue;
    }

    try {
      positions = await liveExecutor.fetchPositions(ex.id);
    } catch {
      // Balance succeeded but positions failed — still include balance
    }

    exchangeStatuses.push({ id: ex.id, exchange: ex.exchange, status: "ok" });

    if (balance) {
      allBalances.push({ exchangeId: ex.id, ...balance });
      // Sum total equity from balance.total (CCXT format: { total: { USDT: 1000, BTC: 0.5, ... } })
      const total = balance.total as Record<string, number> | undefined;
      if (total) {
        for (const value of Object.values(total)) {
          if (typeof value === "number") totalEquity += value;
        }
      }
    }

    if (positions) {
      for (const pos of positions) {
        allPositions.push({ exchangeId: ex.id, ...(pos as Record<string, unknown>) });
      }
    }
  }

  return {
    summary: {
      totalEquity,
      dailyPnl: 0,
      dailyPnlPct: 0,
      positionCount: allPositions.length,
      exchangeCount: exchanges.length,
    },
    positions: allPositions,
    balances: allBalances,
    exchanges: exchangeStatuses,
  };
}

/** Gather Trader Tab data with domain switching (live/paper/backtest). */
export async function gatherTraderData(
  deps: DataGatheringDeps,
  options?: { domain?: TradingDomain },
) {
  const { runtime, eventStore, riskConfig } = deps;
  const domain = options?.domain ?? "paper";

  if (domain === "backtest") {
    // Return backtest results from strategy registry
    const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
      | StrategyRegistryLike
      | undefined;
    const strategies = strategyRegistry?.list() ?? [];
    const backtestResults = strategies
      .filter((s) => s.lastBacktest)
      .map((s) => ({
        strategyId: s.id,
        strategyName: s.name,
        ...s.lastBacktest,
      }));

    return {
      domain,
      backtestResults,
      events: {
        events: eventStore.listEvents(),
        pendingCount: eventStore.pendingCount(),
      },
      risk: {
        enabled: riskConfig.enabled,
        maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
        confirmThresholdUsd: riskConfig.confirmThresholdUsd,
        maxDailyLossUsd: riskConfig.maxDailyLossUsd,
      },
    };
  }

  if (domain === "live") {
    // Live trading data — real exchange balances + positions via LiveExecutor
    const trading = await gatherLiveTradingData(deps);
    const alertEngine = runtime.services?.get?.("fin-alert-engine") as AlertEngineLike | undefined;
    const alerts = alertEngine?.listAlerts() ?? [];

    return {
      domain,
      trading,
      alerts,
      events: {
        events: eventStore.listEvents(),
        pendingCount: eventStore.pendingCount(),
      },
      risk: {
        enabled: riskConfig.enabled,
        maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
        confirmThresholdUsd: riskConfig.confirmThresholdUsd,
        maxDailyLossUsd: riskConfig.maxDailyLossUsd,
      },
    };
  }

  // Default: paper domain
  const trading = gatherTradingData(deps);
  return {
    domain,
    trading,
    events: {
      events: eventStore.listEvents(),
      pendingCount: eventStore.pendingCount(),
    },
    risk: {
      enabled: riskConfig.enabled,
      maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
      confirmThresholdUsd: riskConfig.confirmThresholdUsd,
      maxDailyLossUsd: riskConfig.maxDailyLossUsd,
    },
  };
}

/** Compute fitness decay data for L2/L3 strategies. */
export function computeDecayData(deps: DataGatheringDeps) {
  const { runtime } = deps;

  const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
    | StrategyRegistryLike
    | undefined;
  const paperEngine = runtime.services?.get?.("fin-paper-engine") as PaperEngineLike | undefined;

  const strategies = strategyRegistry?.list() ?? [];
  const l2l3 = strategies.filter((s) => s.level === "L2_PAPER" || s.level === "L3_LIVE");

  return l2l3.map((s) => {
    const snapshots = paperEngine?.getSnapshots?.("default") ?? [];

    // Compute rolling Sharpe from equity snapshots
    const dailyReturns = snapshots
      .filter((snap) => snap.dailyPnlPct != null)
      .map((snap) => snap.dailyPnlPct / 100);

    const rollingSharpe7d = computeRollingSharpe(dailyReturns, 7);
    const rollingSharpe30d = computeRollingSharpe(dailyReturns, 30);

    // Compute current drawdown from equity snapshots
    let peakEquity = 0;
    let currentDrawdown = 0;
    for (const snap of snapshots) {
      if (snap.equity > peakEquity) peakEquity = snap.equity;
    }
    if (peakEquity > 0 && snapshots.length > 0) {
      const lastEquity = snapshots[snapshots.length - 1]!.equity;
      currentDrawdown = ((lastEquity - peakEquity) / peakEquity) * 100;
    }

    // Sharpe momentum = 7d - 30d (positive = improving)
    const sharpeMomentum = rollingSharpe7d - rollingSharpe30d;

    // Classify decay level
    let decayLevel: "healthy" | "warning" | "degrading" | "critical";
    if (rollingSharpe7d < -0.5 || currentDrawdown < -20) {
      decayLevel = "critical";
    } else if (rollingSharpe7d < 0 || currentDrawdown < -10) {
      decayLevel = "degrading";
    } else if (rollingSharpe7d < 0.5) {
      decayLevel = "warning";
    } else {
      decayLevel = "healthy";
    }

    return {
      strategyId: s.id,
      strategyName: s.name,
      decayLevel,
      rollingSharpe7d,
      rollingSharpe30d,
      currentDrawdown,
      sharpeMomentum,
    };
  });
}

function computeRollingSharpe(returns: number[], window: number): number {
  if (returns.length === 0) return 0;
  const slice = returns.slice(-window);
  if (slice.length < 2) return 0;
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, r) => a + (r - mean) ** 2, 0) / (slice.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  // Annualize: daily Sharpe * sqrt(252)
  return (mean / std) * Math.sqrt(252);
}

/** Gather Strategy Tab data (merged Arena + Lab view). */
export function gatherStrategyData(deps: DataGatheringDeps) {
  const { runtime, eventStore, riskConfig } = deps;

  const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
    | StrategyRegistryLike
    | undefined;
  const strategies = strategyRegistry?.list() ?? [];

  const fundManager = runtime.services?.get?.("fin-fund-manager") as FundManagerLike | undefined;
  const fundState = fundManager?.getState?.() ?? { allocations: [], totalCapital: 0 };

  // Pipeline breakdown: count by level
  const pipeline = {
    l0: strategies.filter((s) => s.level === "L0_INCUBATE").length,
    l1: strategies.filter((s) => s.level === "L1_BACKTEST").length,
    l2: strategies.filter((s) => s.level === "L2_PAPER").length,
    l3: strategies.filter((s) => s.level === "L3_LIVE").length,
    killed: strategies.filter((s) => s.level === "KILLED").length,
    total: strategies.length,
  };

  // Strategy details with backtest info
  const strategyData = strategies.map((s) => ({
    id: s.id,
    name: s.name,
    level: s.level,
    status: s.status ?? "running",
    totalReturn: s.lastBacktest?.totalReturn,
    sharpe: s.lastBacktest?.sharpe,
    sortino: s.lastBacktest?.sortino,
    maxDrawdown: s.lastBacktest?.maxDrawdown,
    winRate: s.lastBacktest?.winRate,
    profitFactor: s.lastBacktest?.profitFactor,
    totalTrades: s.lastBacktest?.totalTrades,
  }));

  // Backtests
  const backtests = strategies.filter((s) => s.lastBacktest).map((s) => s.lastBacktest!);

  // Allocations
  const allocItems = fundState.allocations ?? [];
  const totalAllocated = allocItems.reduce(
    (sum: number, a: { capitalUsd: number }) => sum + a.capitalUsd,
    0,
  );

  // Promotion gate config
  const gateConfigStore = runtime.services?.get?.("fin-gate-config") as
    | { get?: () => PromotionGateConfig }
    | undefined;
  const gates: PromotionGateConfig = gateConfigStore?.get?.() ?? {
    l0l1: { minDays: 7, minSharpe: 0.5, maxDrawdown: -0.2, minWinRate: 0.4, minTrades: 10 },
    l1l2: { minDays: 14, minSharpe: 1.0, maxDrawdown: -0.15, minWinRate: 0.45, minTrades: 30 },
    l2l3: { minDays: 30, minSharpe: 1.5, maxDrawdown: -0.1, minWinRate: 0.5, minTrades: 50 },
  };

  // Fitness decay data for L2/L3 strategies
  const decayData = computeDecayData(deps);

  return {
    pipeline,
    strategies: strategyData,
    backtests,
    allocations: {
      items: allocItems,
      totalAllocated,
      cashReserve: (fundState.totalCapital ?? 0) - totalAllocated,
      totalCapital: fundState.totalCapital ?? 0,
    },
    gates,
    decayData,
    events: {
      events: eventStore.listEvents(),
      pendingCount: eventStore.pendingCount(),
    },
    risk: {
      enabled: riskConfig.enabled,
      maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
      confirmThresholdUsd: riskConfig.confirmThresholdUsd,
      maxDailyLossUsd: riskConfig.maxDailyLossUsd,
    },
  };
}

// ── Flow page data (pipeline + lifecycle engine stats) ────────────

type LifecycleEngineLike = {
  getStats(): {
    running: boolean;
    cycleCount: number;
    lastCycleAt: number;
    promotionCount: number;
    demotionCount: number;
    pendingApprovals: number;
  };
};

export function gatherFlowData(deps: DataGatheringDeps, lifecycleEngine?: LifecycleEngineLike) {
  const { runtime, eventStore } = deps;

  const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
    | StrategyRegistryLike
    | undefined;
  const strategies = strategyRegistry?.list() ?? [];

  const paperEngine = runtime.services?.get?.("fin-paper-engine") as PaperEngineLike | undefined;
  const accounts = paperEngine?.listAccounts?.() ?? [];
  const totalEquity = accounts.reduce((sum, a) => sum + a.equity, 0);

  // Strategy cards with key metrics + days-in-level
  const now = Date.now();
  const strategyCards = strategies
    .filter((s) => s.level !== "KILLED")
    .map((s) => ({
      id: s.id,
      name: s.name,
      level: s.level,
      sharpe: s.lastBacktest?.sharpe ?? null,
      maxDrawdown: s.lastBacktest?.maxDrawdown ?? null,
      totalTrades: s.lastBacktest?.totalTrades ?? null,
      daysInLevel: Math.floor(
        (now -
          ((s as { updatedAt?: number; createdAt?: number }).updatedAt ||
            (s as { createdAt?: number }).createdAt ||
            now)) /
          86_400_000,
      ),
    }));

  // Pending approvals: events with type=trade_pending, status=pending, action=promote_l3
  const pendingEvents = eventStore
    .listEvents({ status: "pending" })
    .filter((e) => e.actionParams?.action === "promote_l3");
  const pendingApprovals = pendingEvents
    .map((e) => (e.actionParams?.strategyId as string) ?? "")
    .filter(Boolean);

  const engineStats = lifecycleEngine?.getStats() ?? {
    running: false,
    cycleCount: 0,
    lastCycleAt: 0,
    promotionCount: 0,
    demotionCount: 0,
    pendingApprovals: 0,
  };

  return {
    strategies: strategyCards,
    totalEquity,
    pendingApprovals,
    lifecycleEngine: engineStats,
  };
}
