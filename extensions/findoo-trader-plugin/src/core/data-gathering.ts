/**
 * Data gathering functions that aggregate state from multiple fin-* services
 * for dashboard rendering and API responses.
 */

import type { LiveExecutor } from "../execution/live-executor.js";
import type { BacktestProgressStore } from "../strategy/backtest-progress-store.js";
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
  fundLaunchOrchestrator?: import("../fund/fund-launch-orchestrator.js").FundLaunchOrchestrator;
  backtestProgressStore?: BacktestProgressStore;
  mistakeJournal?: {
    listRecent(limit: number): Array<{
      pattern: string;
      rootCause: string;
      fix: string;
      confidence: number;
      timestamp: number;
    }>;
  };
  diffLog?: {
    listRecent(limit: number): Array<{
      type: string;
      name: string;
      detail: string;
      version: string;
      timestamp: number;
      diff?: string;
    }>;
  };
  trustManager?: {
    getState(stats?: { total: number; correct: number }): {
      level: number;
      preset: string;
      autoThreshold: number;
      confirmThreshold: number;
      history: Array<{ date: string; from: number; to: number; reason: string }>;
    };
  };
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
    // Enrich orders with price alias and positions with strategyName
    positions: allPositions.map((p) => {
      const sid = (p as Record<string, unknown>).strategyId as string | undefined;
      const strat = sid ? strategies.find((s) => s.id === sid) : null;
      return {
        ...p,
        strategyName: strat?.name ?? (p as Record<string, unknown>).strategyName ?? null,
      };
    }),
    orders: allOrders.map((o) => ({
      ...o,
      price:
        (o as Record<string, unknown>).fillPrice ?? (o as Record<string, unknown>).price ?? null,
    })),
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

/** Gather overview data (mission control + finance config + top strategies + alerts + risk). */
export function gatherOverviewData(deps: DataGatheringDeps) {
  const mc = gatherMissionControlData(deps);
  const config = gatherFinanceConfigData(deps);
  const { runtime, riskConfig } = deps;

  // Top Strategies: reuse evolution lookup pattern from gatherStrategyData
  const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
    | StrategyRegistryLike
    | undefined;
  const strategies = strategyRegistry?.list() ?? [];

  const evoService = runtime.services?.get?.("fin-evolution-engine") as
    | EvolutionServiceLike
    | undefined;
  const evoStore = evoService?.store;
  const evoLookup = new Map<
    string,
    { generation: number; fitness: number; survivalTier: string }
  >();
  if (evoStore) {
    try {
      for (const node of evoStore.getActiveNodes()) {
        const existing = evoLookup.get(node.strategyId);
        if (!existing || node.generation > existing.generation) {
          evoLookup.set(node.strategyId, {
            generation: node.generation,
            fitness: node.fitness,
            survivalTier: node.survivalTier,
          });
        }
      }
    } catch {
      // evolution engine may not be loaded
    }
  }

  // Build top strategies (exclude KILLED, sort by fitness desc, top 5)
  const topStrategies = strategies
    .filter((s) => s.level !== "KILLED")
    .map((s) => {
      const evo = evoLookup.get(s.id);
      return {
        id: s.id,
        name: s.name,
        level: s.level,
        fitness: evo?.fitness ?? (s.lastBacktest?.sharpe ?? 0) / 2,
        totalReturn: s.lastBacktest?.totalReturn ?? 0,
      };
    })
    .sort((a, b) => b.fitness - a.fitness)
    .slice(0, 5);

  // Alert summary
  const alertEngine = runtime.services?.get?.("fin-alert-engine") as AlertEngineLike | undefined;
  const allAlerts = alertEngine?.listAlerts() ?? [];
  const alertSummary = {
    total: allAlerts.length,
    triggered: allAlerts.filter((a) => a.triggeredAt != null).length,
  };

  // Risk details (maxDD will be populated below after maxDrawdown is computed)
  const riskDetails: {
    tradingEnabled: boolean;
    maxAutoUsd: number;
    dailyLossUsd: number;
    maxPositionPct: number;
    maxDD: number;
  } = {
    tradingEnabled: riskConfig.enabled,
    maxAutoUsd: riskConfig.maxAutoTradeUsd,
    dailyLossUsd: riskConfig.maxDailyLossUsd,
    maxPositionPct: riskConfig.maxPositionPct,
    maxDD: 0,
  };

  // Pipeline breakdown by level (for Overview dashboard)
  const pipeline = {
    l0: strategies.filter((s) => s.level === "L0_INCUBATE").length,
    l1: strategies.filter((s) => s.level === "L1_BACKTEST").length,
    l2: strategies.filter((s) => s.level === "L2_PAPER").length,
    l3: strategies.filter((s) => s.level === "L3_LIVE").length,
    total: strategies.filter((s) => s.level !== "KILLED").length,
  };

  // Alpha Factory stats
  const alphaFactoryService = runtime.services?.get?.("fin-alpha-factory") as
    | { getStats?: () => Record<string, unknown> }
    | undefined;
  const alphaFactory = alphaFactoryService?.getStats?.() ?? {
    running: false,
    ideationCount: 0,
    screeningPassed: 0,
    screeningFailed: 0,
    validationPassed: 0,
    validationFailed: 0,
    gcKilled: 0,
    evolutionCycles: 0,
    lastCycleAt: 0,
  };

  // Feed events: most recent 20 events (with narration for v0.2 Feed Cards)
  const feedEvents = deps.eventStore.listEvents().slice(0, 20);

  // Fund launch state
  const launchOrch = deps.fundLaunchOrchestrator;
  const launchState = launchOrch?.getState();
  const launch = {
    isFirstRun: strategies.length === 0,
    hasExchange: (deps.registry?.listExchanges?.()?.length ?? 0) > 0,
    activePhase: launchState?.phase !== "idle" ? (launchState?.phase ?? null) : null,
  };

  // Risk budget usage: dailyPnl vs maxDailyLossUsd
  const riskBudgetUsed =
    riskConfig.maxDailyLossUsd > 0
      ? Math.min(1, Math.abs(mc.trading.summary.dailyPnl) / riskConfig.maxDailyLossUsd)
      : 0;
  const maxDrawdown = (() => {
    const snaps = mc.trading.snapshots ?? [];
    if (snaps.length === 0) return 0;
    let peak = 0;
    let dd = 0;
    for (const snap of snaps) {
      const eq = (snap as { equity: number }).equity;
      if (eq > peak) peak = eq;
      if (peak > 0) dd = Math.min(dd, ((eq - peak) / peak) * 100);
    }
    return dd;
  })();

  // Wire maxDD into riskDetails now that it's computed
  riskDetails.maxDD = maxDrawdown;

  // v0.3 dashboard additions
  const { summary } = mc.trading;
  const trading = mc.trading;
  const trust = deps.trustManager?.getState({
    total: summary.winRate != null ? Math.round(summary.winRate * 100) : 0,
    correct:
      summary.winRate != null ? Math.round(summary.winRate * (trading.orders?.length || 0)) : 0,
  }) ?? { level: 2, preset: "balanced", autoThreshold: 100, confirmThreshold: 500, history: [] };
  const review = {
    accuracy: summary.winRate != null ? Math.round(summary.winRate * 100) : 0,
    total: trading.orders?.length || 0,
    correct:
      summary.winRate != null ? Math.round(summary.winRate * (trading.orders?.length || 0)) : 0,
    best: null as { description: string; value: number } | null,
    worst: null as { description: string; value: number } | null,
  };
  const mistakes = deps.mistakeJournal?.listRecent(5) ?? [];
  const skillChanges = deps.diffLog?.listRecent(5) ?? [];
  const scenes = deps.eventStore.listEvents().slice(0, 20);

  return {
    ...mc,
    config,
    topStrategies,
    alertSummary,
    riskDetails,
    pipeline,
    alphaFactory,
    feedEvents,
    launch,
    trust,
    review,
    mistakes,
    skillChanges,
    scenes,
    riskBudgetUsed,
    maxDrawdown,
  };
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
export function gatherSettingData(
  deps: DataGatheringDeps & {
    healthStore?: ExchangeHealthStore;
    pluginConfig?: Record<string, unknown>;
  },
) {
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

  // Read real notification config from pluginConfig (falls back to env vars)
  const nc = (deps.pluginConfig as Record<string, unknown> | undefined)?.notifications as
    | Record<string, unknown>
    | undefined;
  const mask = (v?: string) => (v && v.length > 8 ? v.slice(0, 8) + "***" : v);
  const tgChatId =
    (nc?.telegramChatId as string | undefined) ?? process.env.FINDOO_TELEGRAM_CHAT_ID;
  const tgBotToken =
    (nc?.telegramBotToken as string | undefined) ??
    process.env.FINDOO_TELEGRAM_BOT_TOKEN ??
    process.env.TELEGRAM_BOT_TOKEN;
  const dcWebhook = nc?.discordWebhookUrl as string | undefined;
  const emailAddr = nc?.emailTo as string | undefined;
  const notifications: NotificationConfig = {
    telegram: { enabled: !!tgChatId, chatId: mask(tgChatId) },
    discord: { enabled: !!dcWebhook, webhookUrl: mask(dcWebhook) },
    email: { enabled: !!emailAddr, address: emailAddr },
  };

  const plugins = FINANCIAL_PLUGIN_IDS.map((id) => ({
    id,
    enabled: pluginEntries[id]?.enabled === true,
  }));

  // Equity summary for topbar display
  const paperEngine = runtime.services?.get?.("fin-paper-engine") as PaperEngineLike | undefined;
  const accounts = paperEngine?.listAccounts() ?? [];
  let totalEquity = 0;
  let totalDailyPnl = 0;
  for (const acct of accounts) {
    const state = paperEngine?.getAccountState(acct.id);
    if (state) totalEquity += state.equity;
    const snaps = paperEngine?.getSnapshots(acct.id) ?? [];
    if (snaps.length > 0) totalDailyPnl += snaps[snaps.length - 1]!.dailyPnl;
  }

  // Notifications as channels array for frontend consumption
  const notificationChannels = [
    {
      icon: "✈️",
      name: "Telegram",
      enabled: notifications.telegram.enabled,
      connected: notifications.telegram.enabled,
      detail: notifications.telegram.chatId ?? "--",
    },
    {
      icon: "💬",
      name: "Discord",
      enabled: notifications.discord.enabled,
      connected: notifications.discord.enabled,
      detail: notifications.discord.webhookUrl ?? "--",
    },
    {
      icon: "📧",
      name: "Email",
      enabled: notifications.email.enabled,
      connected: notifications.email.enabled,
      detail: notifications.email.address ?? "--",
    },
  ];

  // Enrich exchanges with display fields for frontend (name/label/market)
  const enrichedExchanges = exchanges.map((ex: Record<string, unknown>) => {
    const exId = (ex.id as string) ?? "";
    const exName = (ex.exchange as string) ?? exId;
    const health = exchangeHealth.find((h: Record<string, unknown>) => h.exchangeId === exId);
    const displayName = exName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    return {
      ...ex,
      name: displayName,
      label: exName,
      market: (ex as Record<string, unknown>).testnet ? "Crypto (Testnet)" : "Crypto",
      lastPingMs: (health as Record<string, unknown> | undefined)?.lastPingMs ?? null,
      lastSync: (health as Record<string, unknown> | undefined)?.lastSync ?? null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    exchanges: enrichedExchanges,
    exchangeHealth,
    // Equity for topbar
    equity: {
      total: totalEquity,
      dailyPnl: totalDailyPnl,
      dailyPnlPct: totalEquity > 0 ? (totalDailyPnl / totalEquity) * 100 : 0,
    },
    trading: {
      enabled: riskConfig.enabled,
      maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
      confirmThresholdUsd: riskConfig.confirmThresholdUsd,
      maxDailyLossUsd: riskConfig.maxDailyLossUsd,
      maxPositionPct: riskConfig.maxPositionPct,
      maxLeverage: riskConfig.maxLeverage,
      allowedPairs: riskConfig.allowedPairs ?? [],
      blockedPairs: riskConfig.blockedPairs ?? [],
      // Frontend-friendly aliases
      autoExecThreshold: riskConfig.maxAutoTradeUsd,
      confirmThreshold: riskConfig.confirmThresholdUsd,
      maxDailyLoss: riskConfig.maxDailyLossUsd,
      maxCryptoExposure: 60, // TODO: make configurable
    },
    agent,
    gates,
    notifications: {
      ...notifications,
      channels: notificationChannels,
    },
    onboarding: { completed: exchanges.length > 0 },
    plugins: {
      total: plugins.length,
      enabled: plugins.filter((entry) => entry.enabled).length,
      entries: plugins,
    },
    soul: { content: "" }, // SOUL.md content will be injected by the HTTP handler
    trust: deps.trustManager?.getState() ?? {
      level: 2,
      preset: "balanced",
      autoThreshold: 100,
      confirmThreshold: 500,
      history: [],
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
      orderCount: 0,
      exchangeCount: 0,
    },
    positions: [] as Array<Record<string, unknown>>,
    balances: [] as Array<Record<string, unknown>>,
    orders: [] as Array<Record<string, unknown>>,
    exchanges: [] as Array<{ id: string; exchange: string; status: string }>,
  };

  if (!liveExecutor) return emptyResult;

  const exchanges = registry.listExchanges();
  const allPositions: Array<Record<string, unknown>> = [];
  const allBalances: Array<Record<string, unknown>> = [];
  const allOrders: Array<Record<string, unknown>> = [];
  const exchangeStatuses: Array<{ id: string; exchange: string; status: string }> = [];
  let totalEquity = 0;
  let totalUnrealizedPnl = 0;

  // Type for fetchOpenOrders — LiveExecutor delegates to CcxtBridge which has it
  type LiveExecutorExt = typeof liveExecutor & {
    fetchOpenOrders?: (exchangeId?: string, symbol?: string) => Promise<unknown[]>;
  };
  const executor = liveExecutor as LiveExecutorExt;

  for (const ex of exchanges) {
    let balance: Record<string, unknown> | undefined;
    let positions: unknown[] | undefined;
    let openOrders: unknown[] | undefined;

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

    // Fetch open orders if method is available
    try {
      if (executor.fetchOpenOrders) {
        openOrders = await executor.fetchOpenOrders(ex.id);
      }
    } catch {
      // Non-fatal — open orders are supplementary
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
        const posData = pos as Record<string, unknown>;
        const posRecord = { exchangeId: ex.id, ...posData };
        allPositions.push(posRecord);
        // Accumulate unrealized PnL from CCXT position format
        const unrealizedPnl = posData.unrealizedPnl;
        if (typeof unrealizedPnl === "number") {
          totalUnrealizedPnl += unrealizedPnl;
        }
      }
    }

    if (openOrders) {
      for (const order of openOrders) {
        allOrders.push({ exchangeId: ex.id, ...(order as Record<string, unknown>) });
      }
    }
  }

  // Enrich live positions with strategyName by matching symbol to L3 strategies
  const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
    | StrategyRegistryLike
    | undefined;
  const allStrategies = strategyRegistry?.list() ?? [];
  for (const pos of allPositions) {
    const sym = pos.symbol as string | undefined;
    if (!sym) continue;
    const matching = allStrategies.find(
      (s) =>
        s.level === "L3_LIVE" &&
        (s.definition as { symbols?: string[] } | undefined)?.symbols?.includes(sym),
    );
    if (matching) {
      pos.strategyName = matching.name;
      pos.strategyId = matching.id;
    }
  }

  return {
    summary: {
      totalEquity,
      dailyPnl: totalUnrealizedPnl,
      dailyPnlPct: totalEquity > 0 ? (totalUnrealizedPnl / totalEquity) * 100 : 0,
      positionCount: allPositions.length,
      orderCount: allOrders.length,
      exchangeCount: exchanges.length,
    },
    positions: allPositions,
    balances: allBalances,
    orders: allOrders,
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

  // Trade-related feed events for v0.2 Feed Cards
  const feedEvents = eventStore
    .listEvents()
    .filter(
      (e) =>
        e.type === "trade_executed" ||
        e.type === "trade_pending" ||
        e.type === "order_filled" ||
        e.type === "order_cancelled" ||
        e.type === "emergency_stop" ||
        e.type === "alert_triggered",
    )
    .slice(0, 20);

  // Compute position exposure for risk gauge
  const paperEngine = runtime.services?.get?.("fin-paper-engine") as PaperEngineLike | undefined;
  const traderAccounts = paperEngine?.listAccounts() ?? [];
  let traderEquity = 0;
  let traderPosValue = 0;
  for (const acct of traderAccounts) {
    const state = paperEngine?.getAccountState(acct.id);
    if (state) {
      traderEquity += state.equity;
      for (const pos of state.positions) {
        traderPosValue += Math.abs(pos.currentPrice * pos.quantity);
      }
    }
  }
  const exposurePct = traderEquity > 0 ? Math.round((traderPosValue / traderEquity) * 100) : 0;

  // Market regime data from fin-regime-detector service
  const regimeDetector = runtime.services?.get?.("fin-regime-detector") as
    | {
        getRegimes?: () => Array<{
          label: string;
          status: string;
          strength: number;
          color: string;
        }>;
      }
    | undefined;
  const regimes = regimeDetector?.getRegimes?.() ?? [];

  const riskData = {
    enabled: riskConfig.enabled,
    maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
    confirmThresholdUsd: riskConfig.confirmThresholdUsd,
    maxDailyLossUsd: riskConfig.maxDailyLossUsd,
    currentExposurePct: exposurePct,
    level: exposurePct > 75 ? "HIGH" : exposurePct > 50 ? "ELEVATED" : "NORMAL",
  };

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
      events: { events: eventStore.listEvents(), pendingCount: eventStore.pendingCount() },
      risk: riskData,
      regimes,
      feedEvents,
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
      events: { events: eventStore.listEvents(), pendingCount: eventStore.pendingCount() },
      risk: riskData,
      regimes,
      feedEvents,
    };
  }

  // Default: paper domain
  const trading = gatherTradingData(deps);
  return {
    domain,
    trading,
    events: { events: eventStore.listEvents(), pendingCount: eventStore.pendingCount() },
    risk: riskData,
    regimes,
    feedEvents,
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

// Minimal type for cross-extension evolution service access
type EvolutionStoreLike = {
  getLatestGeneration(strategyId: string):
    | {
        generation: number;
        fitness: number;
        survivalTier: string;
      }
    | undefined;
  getAuditLog(opts?: { limit?: number }): Array<{
    id: string;
    type: string;
    strategyId: string;
    strategyName?: string;
    detail: string;
    triggeredBy: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
  }>;
  getNodeCountByTier(): Record<string, number>;
  getTotalMutations(): { total: number; successful: number };
  getActiveNodes(): Array<{
    strategyId: string;
    fitness: number;
    survivalTier: string;
    generation: number;
  }>;
};

type EvolutionServiceLike = {
  store: EvolutionStoreLike;
};

/** Gather Strategy Tab data (merged Arena + Lab view). */
export function gatherStrategyData(deps: DataGatheringDeps) {
  const { runtime, eventStore, riskConfig } = deps;

  const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
    | StrategyRegistryLike
    | undefined;
  const strategies = strategyRegistry?.list() ?? [];

  // Equity summary for topbar (same pattern as gatherSettingData)
  const paperEngine = runtime.services?.get?.("fin-paper-engine") as PaperEngineLike | undefined;
  const paperAccounts = paperEngine?.listAccounts() ?? [];
  let totalEquity = 0;
  let totalDailyPnl = 0;
  for (const acct of paperAccounts) {
    const state = paperEngine?.getAccountState(acct.id);
    if (state) totalEquity += state.equity;
    const snaps = paperEngine?.getSnapshots(acct.id) ?? [];
    if (snaps.length > 0) totalDailyPnl += snaps[snaps.length - 1]!.dailyPnl;
  }
  const dailyPnlPct = totalEquity > 0 ? (totalDailyPnl / totalEquity) * 100 : 0;

  const fundManager = runtime.services?.get?.("fin-fund-manager") as FundManagerLike | undefined;
  const fundState = fundManager?.getState?.() ?? { allocations: [], totalCapital: 0 };

  // ── Evolution engine integration ──
  const evoService = runtime.services?.get?.("fin-evolution-engine") as
    | EvolutionServiceLike
    | undefined;
  const evoStore = evoService?.store;

  // Build per-strategy evolution lookup
  const evoLookup = new Map<
    string,
    { generation: number; fitness: number; survivalTier: string }
  >();
  if (evoStore) {
    try {
      const activeNodes = evoStore.getActiveNodes();
      for (const node of activeNodes) {
        const existing = evoLookup.get(node.strategyId);
        if (!existing || node.generation > existing.generation) {
          evoLookup.set(node.strategyId, {
            generation: node.generation,
            fitness: node.fitness,
            survivalTier: node.survivalTier,
          });
        }
      }
    } catch {
      // evolution engine may not be loaded
    }
  }

  // Pipeline breakdown: count by level
  const pipeline = {
    l0: strategies.filter((s) => s.level === "L0_INCUBATE").length,
    l1: strategies.filter((s) => s.level === "L1_BACKTEST").length,
    l2: strategies.filter((s) => s.level === "L2_PAPER").length,
    l3: strategies.filter((s) => s.level === "L3_LIVE").length,
    killed: strategies.filter((s) => s.level === "KILLED").length,
    total: strategies.length,
  };

  // Strategy details with backtest info + evolution enrichment + market/symbol/timeframe
  const strategyData = strategies.map((s) => {
    const evo = evoLookup.get(s.id);
    const def = s.definition as
      | { markets?: string[]; symbols?: string[]; timeframes?: string[] }
      | undefined;
    // Derive market type: first entry from definition.markets (lowercase passthrough)
    const market = def?.markets?.[0]?.toLowerCase() ?? null;
    // Derive symbols array and primary timeframe
    const symbols = def?.symbols ?? [];
    const timeframe = def?.timeframes?.[0] ?? null;
    return {
      id: s.id,
      name: s.name,
      level: s.level,
      status: s.status ?? "running",
      market,
      symbols,
      timeframe,
      totalReturn: s.lastBacktest?.totalReturn,
      sharpe: s.lastBacktest?.sharpe,
      sortino: s.lastBacktest?.sortino,
      maxDrawdown: s.lastBacktest?.maxDrawdown,
      winRate: s.lastBacktest?.winRate,
      profitFactor: s.lastBacktest?.profitFactor,
      totalTrades: s.lastBacktest?.totalTrades,
      // Evolution enrichment (null if engine not loaded or no data)
      fitness: evo?.fitness ?? null,
      generation: evo?.generation ?? null,
      survivalTier: evo?.survivalTier ?? null,
    };
  });

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

  // ── Evolution events + stats ──
  let evolutionEvents: Array<Record<string, unknown>> = [];
  let evolutionStats: {
    byTier: Record<string, number>;
    mutations: { total: number; successful: number };
    activeCount: number;
    avgFitness: number;
  } | null = null;

  if (evoStore) {
    try {
      evolutionEvents = evoStore.getAuditLog({ limit: 50 });
      const byTier = evoStore.getNodeCountByTier();
      const mutations = evoStore.getTotalMutations();
      const activeNodes = evoStore.getActiveNodes();
      const fitnesses = activeNodes.map((n) => n.fitness);
      const avgFitness =
        fitnesses.length > 0 ? fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length : 0;
      evolutionStats = {
        byTier,
        mutations,
        activeCount: activeNodes.length,
        avgFitness,
      };
    } catch {
      // evolution engine query failed — non-fatal
    }
  }

  return {
    pipeline,
    strategies: strategyData,
    backtests,
    // Trading summary for strategy page topbar
    trading: {
      summary: {
        totalEquity,
        dailyPnl: totalDailyPnl,
        dailyPnlPct,
        strategyCount: strategies.length,
      },
    },
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
    evolutionEvents,
    evolutionStats,
    // Backtest queue: active/running backtests from BacktestProgressStore
    backtestQueue:
      deps.backtestProgressStore?.getActive?.()?.map((p) => ({
        strategyId: p.strategyId,
        status: p.status,
        percentComplete: p.percentComplete,
        currentBar: p.currentBar,
        totalBars: p.totalBars,
      })) ?? [],
    // Feed events: strategy-related events (renamed to strategyEvents for frontend)
    feedEvents: eventStore
      .listEvents()
      .filter(
        (e) =>
          e.type === "strategy_promoted" ||
          e.type === "strategy_killed" ||
          e.type === "trade_pending" ||
          e.type === "system",
      )
      .slice(0, 20),
    // Alias for frontend compatibility
    strategyEvents: eventStore
      .listEvents()
      .filter(
        (e) =>
          e.type === "strategy_promoted" ||
          e.type === "strategy_killed" ||
          e.type === "trade_pending" ||
          e.type === "system",
      )
      .slice(0, 10),
    // Agent brief: synthesized from pipeline + decay + evolution
    brief: {
      updatedAt: new Date().toISOString(),
      summary: `策略管线: ${pipeline.l3} 个实盘, ${pipeline.l2} 个模拟, ${pipeline.l1} 个回测, ${pipeline.l0} 个孵化。${decayData.filter((d) => d.decayLevel === "critical" || d.decayLevel === "degrading").length > 0 ? `${decayData.filter((d) => d.decayLevel === "critical" || d.decayLevel === "degrading").length} 个策略衰退中。` : "所有策略健康运行。"}${evolutionStats ? ` 进化引擎: ${evolutionStats.activeCount} 个活跃, 平均 Fitness ${evolutionStats.avgFitness.toFixed(2)}。` : ""}`,
    },
    // Recommendations: promote/decay/new suggestions from strategy data
    recommendations: [
      ...strategyData
        .filter((s) => s.level === "L1_BACKTEST" && s.sharpe != null && s.sharpe >= 1.2)
        .slice(0, 2)
        .map((s) => ({
          type: "promote" as const,
          strategyId: s.id,
          strategyName: s.name,
          from: "L1",
          to: "L2",
          reason: `Sharpe ${s.sharpe?.toFixed(1)}, Return ${((s.totalReturn ?? 0) * 100).toFixed(1)}%`,
          metrics: { sharpe: s.sharpe, totalReturn: s.totalReturn, maxDrawdown: s.maxDrawdown },
        })),
      ...decayData
        .filter((d) => d.decayLevel === "critical" || d.decayLevel === "degrading")
        .slice(0, 2)
        .map((d) => ({
          type: "decay" as const,
          strategyId: d.strategyId,
          strategyName: d.strategyName,
          reason: `Fitness 衰退, 7d Sharpe ${d.rollingSharpe7d.toFixed(2)}, DD ${d.currentDrawdown.toFixed(1)}%`,
          metrics: { rollingSharpe7d: d.rollingSharpe7d, currentDrawdown: d.currentDrawdown },
        })),
    ],
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
