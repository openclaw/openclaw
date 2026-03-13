/**
 * findoo-trader-plugin — unified trading infrastructure.
 * Merges fin-core + fin-trading + fin-paper-trading + fin-strategy-engine + fin-fund-manager
 * into a single cohesive plugin.
 *
 * Services: fin-exchange-registry, fin-risk-controller, fin-event-store,
 *           fin-exchange-health-store, fin-live-executor,
 *           fin-paper-engine, fin-strategy-registry, fin-fund-manager
 * AI Tools (23): 5 trading + 6 paper + 5 strategy + 7 fund
 * HTTP Routes: 38 (API + dashboards)
 * SSE Streams: 4 (config, trading, events, fund)
 * CLI Commands: exchange list/add/remove, fund pipeline
 * Bot Commands: /fund, /risk, /lb, /alloc, /promote
 * Hooks: before_tool_call risk gate, before_prompt_build financial context
 * Notification: Telegram event routing + inline approval buttons
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { EvolutionScheduler } from "./src/alpha-factory/evolution-scheduler.js";
import { GarbageCollector } from "./src/alpha-factory/garbage-collector.js";
import { AlphaFactoryOrchestrator } from "./src/alpha-factory/orchestrator.js";
import { ScreeningPipeline } from "./src/alpha-factory/screening-pipeline.js";
import { resolveConfig } from "./src/config.js";
import { ActivityLogStore } from "./src/core/activity-log-store.js";
import { AgentEventSqliteStore } from "./src/core/agent-event-sqlite-store.js";
import { AgentWakeBridge } from "./src/core/agent-wake-bridge.js";
import { AlertEngine } from "./src/core/alert-engine.js";
import { JsonConfigStore } from "./src/core/config-store.js";
import { DailyBriefScheduler } from "./src/core/daily-brief-scheduler.js";
import type { DataGatheringDeps } from "./src/core/data-gathering.js";
import { ExchangeHealthStore } from "./src/core/exchange-health-store.js";
import { ExchangeRegistry } from "./src/core/exchange-registry.js";
import { HealthProbe } from "./src/core/health-probe.js";
import { LifecycleEngine } from "./src/core/lifecycle-engine.js";
import { NotificationRouter } from "./src/core/notification-router.js";
import { buildFinancialContext } from "./src/core/prompt-context.js";
import { RiskController } from "./src/core/risk-controller.js";
import { RiskStateStore } from "./src/core/risk-state-store.js";
import { registerHttpRoutes } from "./src/core/route-handlers.js";
import { registerSseRoutes } from "./src/core/sse-handlers.js";
import { registerTelegramApprovalRoute } from "./src/core/telegram-approval.js";
import { loadDashboardTemplates } from "./src/core/template-renderer.js";
import { LiveExecutor } from "./src/execution/live-executor.js";
import { LiveHealthMonitor } from "./src/execution/live-health-monitor.js";
import { LiveReconciler } from "./src/execution/live-reconciler.js";
import { OrderTracker } from "./src/execution/order-tracker.js";
import { registerTradingTools } from "./src/execution/trading-tools.js";
import { CapitalFlowStore } from "./src/fund/capital-flow-store.js";
import { ColdStartSeeder } from "./src/fund/cold-start-seeder.js";
import { FundManager } from "./src/fund/fund-manager.js";
import { PerformanceSnapshotStore } from "./src/fund/performance-snapshot-store.js";
import { registerPackRoutes } from "./src/fund/routes-packs.js";
import { registerFundRoutes } from "./src/fund/routes.js";
import { registerFundTools } from "./src/fund/tools.js";
import type { FundConfig } from "./src/fund/types.js";
import { BatchHypothesisGenerator } from "./src/ideation/batch-generator.js";
import { DeduplicationFilter } from "./src/ideation/dedup-filter.js";
import { FailureFeedbackStore } from "./src/ideation/failure-feedback-store.js";
import { IdeationEngine } from "./src/ideation/ideation-engine.js";
import { IdeationScheduler } from "./src/ideation/ideation-scheduler.js";
import { MarketScanner } from "./src/ideation/market-scanner.js";
import { DEFAULT_IDEATION_CONFIG } from "./src/ideation/types.js";
import type { IdeationConfig } from "./src/ideation/types.js";
import { PaperEngine } from "./src/paper/paper-engine.js";
import { PaperHealthMonitor } from "./src/paper/paper-health-monitor.js";
import { PaperScheduler } from "./src/paper/paper-scheduler.js";
import { PaperStore } from "./src/paper/paper-store.js";
import { registerPaperTools } from "./src/paper/tools.js";
import { BacktestProgressStore } from "./src/strategy/backtest-progress-store.js";
import { RemoteBacktestBridge } from "./src/strategy/remote-backtest-bridge.js";
import { StrategyRegistry } from "./src/strategy/strategy-registry.js";
import { registerStrategyTools } from "./src/strategy/tools.js";
import type { RuntimeServices } from "./src/types-http.js";
import type { ExchangeConfig } from "./src/types.js";

// Re-exports for external consumers (fin-evolution-engine, fin-monitoring, etc.)
export { AgentEventSqliteStore } from "./src/core/agent-event-sqlite-store.js";
export { AgentEventStore } from "./src/core/agent-event-store.js";
export { AlertEngine } from "./src/core/alert-engine.js";
export { JsonConfigStore } from "./src/core/config-store.js";
export { ExchangeHealthStore } from "./src/core/exchange-health-store.js";
export { ExchangeRegistry } from "./src/core/exchange-registry.js";
export { LiveExecutor } from "./src/execution/live-executor.js";
export { LiveHealthMonitor } from "./src/execution/live-health-monitor.js";
export { LiveReconciler } from "./src/execution/live-reconciler.js";
export { RiskController } from "./src/core/risk-controller.js";
export { RiskStateStore } from "./src/core/risk-state-store.js";
export { HealthProbe } from "./src/core/health-probe.js";
export { OrderTracker } from "./src/execution/order-tracker.js";
export { CcxtBridge, CcxtBridgeError } from "./src/execution/ccxt-bridge.js";
export { PaperEngine } from "./src/paper/paper-engine.js";
export { PaperStore } from "./src/paper/paper-store.js";
export { RemoteBacktestBridge } from "./src/strategy/remote-backtest-bridge.js";
export { buildIndicatorLib } from "./src/strategy/indicator-lib.js";
export { StrategyRegistry } from "./src/strategy/strategy-registry.js";
export { NotificationRouter } from "./src/core/notification-router.js";
export { buildFinancialContext } from "./src/core/prompt-context.js";
export type { PromptContextDeps } from "./src/core/prompt-context.js";
export { DailyBriefScheduler } from "./src/core/daily-brief-scheduler.js";
export { PaperScheduler } from "./src/paper/paper-scheduler.js";
export { PaperHealthMonitor } from "./src/paper/paper-health-monitor.js";
export { BacktestProgressStore } from "./src/strategy/backtest-progress-store.js";
export { FundManager } from "./src/fund/fund-manager.js";
export { CapitalAllocator } from "./src/fund/capital-allocator.js";
export { PromotionPipeline } from "./src/fund/promotion-pipeline.js";
export { FundRiskManager } from "./src/fund/fund-risk-manager.js";
export { Leaderboard } from "./src/fund/leaderboard.js";
export { CorrelationMonitor } from "./src/fund/correlation-monitor.js";
export { CapitalFlowStore } from "./src/fund/capital-flow-store.js";
export { PerformanceSnapshotStore } from "./src/fund/performance-snapshot-store.js";
export { ColdStartSeeder } from "./src/fund/cold-start-seeder.js";
export { ActivityLogStore } from "./src/core/activity-log-store.js";
export { AgentWakeBridge } from "./src/core/agent-wake-bridge.js";
export { LifecycleEngine } from "./src/core/lifecycle-engine.js";
export { STRATEGY_PACKS, getStrategyPack } from "./src/fund/strategy-packs.js";
export { MarketScanner } from "./src/ideation/market-scanner.js";
export { IdeationEngine } from "./src/ideation/ideation-engine.js";
export { IdeationScheduler } from "./src/ideation/ideation-scheduler.js";
export { DeduplicationFilter } from "./src/ideation/dedup-filter.js";
export { AlphaFactoryOrchestrator } from "./src/alpha-factory/orchestrator.js";
export { ScreeningPipeline } from "./src/alpha-factory/screening-pipeline.js";
export { ValidationOrchestrator } from "./src/alpha-factory/validation-orchestrator.js";
export { EvolutionScheduler } from "./src/alpha-factory/evolution-scheduler.js";
export { GarbageCollector } from "./src/alpha-factory/garbage-collector.js";
export { GradualScaleIn } from "./src/alpha-factory/gradual-scale-in.js";
export { CapacityEstimator } from "./src/alpha-factory/capacity-estimator.js";
export { FailureFeedbackStore } from "./src/ideation/failure-feedback-store.js";
export { BatchHypothesisGenerator } from "./src/ideation/batch-generator.js";
export * from "./src/types.js";

const findooTraderPlugin = {
  id: "findoo-trader-plugin",
  name: "Findoo Trader",
  description:
    "Unified trading infrastructure — exchange registry, risk control, paper trading, strategy engine, fund management",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const { apiKey, usingDevKey, exchanges, riskConfig } = resolveConfig(api);

    // ── License Gate: no key → skip all registration ──
    if (!apiKey) {
      api.logger.info(
        "Findoo Trader: license key not configured — plugin inactive. " +
          "Set FINDOO_TRADER_API_KEY env var or configure in Control UI → Plugins → Findoo Trader.",
      );
      return;
    }

    // P3-1: Warn when using built-in dev API key
    if (usingDevKey) {
      api.logger.warn(
        "Findoo Trader: using built-in dev API key — NOT suitable for production. " +
          "Set FINDOO_TRADER_API_KEY or OPENFINCLAW_TRADER_API_KEY for production use.",
      );
    }

    // ── Exchange Registry ──
    // Note: healthStore is created after registry — pass it later via constructor
    const registry = new ExchangeRegistry();
    for (const [name, cfg] of Object.entries(exchanges)) {
      registry.addExchange(name, cfg as ExchangeConfig);
    }

    api.registerService({
      id: "fin-exchange-registry",
      start: () => {},
      instance: registry,
    } as Parameters<typeof api.registerService>[0]);

    // ── Risk Controller (P0-1: persisted daily loss state) ──

    const riskStateStore = new RiskStateStore(api.resolvePath("state/findoo-risk-state.sqlite"));
    const riskController = new RiskController(riskConfig, riskStateStore);

    api.registerService({
      id: "fin-risk-controller",
      start: () => {},
      instance: riskController,
    } as Parameters<typeof api.registerService>[0]);

    // ── Agent Event Store ──

    const eventStore = new AgentEventSqliteStore(api.resolvePath("state/findoo-events.sqlite"));
    api.registerService({
      id: "fin-event-store",
      start: () => {},
      instance: eventStore,
    } as Parameters<typeof api.registerService>[0]);

    // ── Activity Log Store (agent audit trail for Flow timeline) ──

    const activityLog = new ActivityLogStore(api.resolvePath("state/findoo-activity-log.sqlite"));
    api.registerService({
      id: "fin-activity-log",
      start: () => {},
      instance: activityLog,
    } as Parameters<typeof api.registerService>[0]);

    // ── Alert Engine ──

    const alertEngine = new AlertEngine(api.resolvePath("state/findoo-alerts.sqlite"));
    api.registerService({
      id: "fin-alert-engine",
      start: () => {},
      instance: alertEngine,
    } as Parameters<typeof api.registerService>[0]);

    // ── Agent Config Store ──

    const agentConfigStore = new JsonConfigStore(
      api.resolvePath("state/findoo-agent-config.json"),
      {
        heartbeatIntervalMs: 60000,
        discoveryEnabled: true,
        evolutionEnabled: false,
        mutationRate: 0.1,
        maxConcurrentStrategies: 5,
      },
    );
    api.registerService({
      id: "fin-agent-config",
      start: () => {},
      instance: agentConfigStore,
    } as Parameters<typeof api.registerService>[0]);

    // ── Gate Config Store ──

    const gateConfigStore = new JsonConfigStore(api.resolvePath("state/findoo-gate-config.json"), {
      l0l1: { minDays: 7, minSharpe: 0.5, maxDrawdown: -0.2, minWinRate: 0.4, minTrades: 10 },
      l1l2: { minDays: 14, minSharpe: 1.0, maxDrawdown: -0.15, minWinRate: 0.45, minTrades: 30 },
      l2l3: { minDays: 30, minSharpe: 1.5, maxDrawdown: -0.1, minWinRate: 0.5, minTrades: 50 },
    });
    api.registerService({
      id: "fin-gate-config",
      start: () => {},
      instance: gateConfigStore,
    } as Parameters<typeof api.registerService>[0]);

    // ── Exchange Health Store ──

    const healthStore = new ExchangeHealthStore(
      api.resolvePath("state/findoo-exchange-health.sqlite"),
    );

    for (const ex of registry.listExchanges()) {
      healthStore.upsert({
        exchangeId: ex.id,
        exchangeName: ex.exchange,
        connected: false,
        lastPingMs: 0,
        apiCallsToday: 0,
        apiLimit: 1200,
        lastCheckAt: null,
        errorMessage: null,
        consecutiveFailures: 0,
      });
    }

    api.registerService({
      id: "fin-exchange-health-store",
      start: () => {},
      instance: healthStore,
    } as Parameters<typeof api.registerService>[0]);

    // ── Live Executor (P0-2: write-ahead order tracking) ──

    const orderTracker = new OrderTracker(api.resolvePath("state/findoo-orders.sqlite"));
    const liveExecutor = new LiveExecutor(registry, orderTracker);

    // Reconcile any in-flight orders from previous session
    setTimeout(() => void liveExecutor.reconcileInflight(), 3000);

    api.registerService({
      id: "fin-live-executor",
      start: () => {},
      instance: liveExecutor,
    } as Parameters<typeof api.registerService>[0]);

    // ── Load dashboard templates ──

    const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "dashboard");
    const templates = loadDashboardTemplates(dashboardDir);

    // ── Build shared deps for route + data-gathering modules ──

    const runtime = api.runtime as unknown as RuntimeServices;

    // ── Agent Wake Bridge (enqueues system events to wake heartbeat runner) ──

    const enqueueSystemEvent = runtime.system?.enqueueSystemEvent as
      | ((text: string, options: { sessionKey: string; contextKey?: string }) => void)
      | undefined;
    const wakeDbPath = api.resolvePath("state/findoo-activity-log.sqlite");
    const wakeBridge = enqueueSystemEvent
      ? new AgentWakeBridge({
          enqueueSystemEvent,
          sessionKeyResolver: () => "main",
          activityLog,
          dbPath: wakeDbPath,
        })
      : undefined;

    // Drain any undelivered wakes from previous gateway session on startup
    if (wakeBridge) {
      setTimeout(() => wakeBridge.drainUndelivered(), 2000);
    }

    const pluginEntries = (api.config.plugins?.entries ?? {}) as Record<
      string,
      { enabled?: boolean; config?: Record<string, unknown> }
    >;

    const gatherDeps: DataGatheringDeps = {
      registry,
      riskConfig,
      eventStore,
      runtime,
      pluginEntries,
      liveExecutor,
    };

    // ── Backtest Progress Store (created early for SSE + tools wiring) ──

    const progressStore = new BacktestProgressStore();

    // ── Register HTTP routes (API + dashboards) ──

    // lifecycleEngine is created later — use a lazy reference
    const lifecycleRef: { engine?: InstanceType<typeof LifecycleEngine> } = {};
    // GC is created later (Alpha Factory section) — lazy reference for lifecycle engine
    const gcRef: { gc?: InstanceType<typeof GarbageCollector> } = {};

    // ideationScheduler is created later — use a lazy reference
    const ideationRef: { scheduler?: InstanceType<typeof IdeationScheduler> } = {};

    registerHttpRoutes({
      api,
      gatherDeps,
      eventStore,
      healthStore,
      riskController,
      runtime,
      templates,
      registry,
      get lifecycleEngine() {
        return lifecycleRef.engine;
      },
      get ideationScheduler() {
        return ideationRef.scheduler;
      },
    });

    // ── Register SSE streams ──

    registerSseRoutes(api, gatherDeps, eventStore, progressStore, activityLog);

    // ── Register trading AI tools (5 tools from fin-trading) ──

    registerTradingTools(api, registry, riskController);

    // ── Paper Trading Engine ──

    const paperDbPath = api.resolvePath("state/findoo-paper.sqlite");
    const paperStore = new PaperStore(paperDbPath);

    const paperConfig = (api.config?.financial?.paperTrading ?? {}) as Record<string, unknown>;
    const slippageBps =
      (typeof paperConfig.constantSlippageBps === "number"
        ? paperConfig.constantSlippageBps
        : undefined) ??
      (typeof paperConfig.slippageBps === "number" ? paperConfig.slippageBps : undefined) ??
      5;
    const market = typeof paperConfig.market === "string" ? paperConfig.market : "crypto";

    const paperEngine = new PaperEngine({ store: paperStore, slippageBps, market });

    api.registerService({
      id: "fin-paper-engine",
      start: () => {},
      instance: paperEngine,
    } as Parameters<typeof api.registerService>[0]);

    // ── Register paper trading AI tools (6 tools) ──

    registerPaperTools(api, paperEngine);

    // ── Strategy Engine ──

    const strategyRegistryPath = api.resolvePath("state/findoo-strategies.json");
    const strategyRegistry = new StrategyRegistry(strategyRegistryPath);

    // Remote backtest bridge — lazy lookup of fin-remote-backtest service from findoo-backtest-plugin
    const backtestBridge = new RemoteBacktestBridge(() => {
      try {
        const svc = runtime.services?.get?.("fin-remote-backtest");
        return svc as
          | import("./src/strategy/remote-backtest-bridge.js").RemoteBacktestService
          | undefined;
      } catch {
        return undefined;
      }
    });

    api.registerService({
      id: "fin-strategy-registry",
      start: () => {},
      instance: strategyRegistry,
    } as Parameters<typeof api.registerService>[0]);

    // ── Register strategy AI tools (5 tools, L3 uses liveExecutor directly) ──

    registerStrategyTools(
      api,
      strategyRegistry,
      backtestBridge,
      liveExecutor,
      paperEngine,
      progressStore,
    );

    // ── Fund Manager ──

    const financialConfig = (api.config as Record<string, unknown>)?.financial as
      | Record<string, unknown>
      | undefined;
    const fundCfg = (financialConfig?.fund ?? {}) as Partial<FundConfig>;

    const fundConfig: FundConfig = {
      totalCapital: fundCfg.totalCapital,
      cashReservePct: fundCfg.cashReservePct ?? 30,
      maxSingleStrategyPct: fundCfg.maxSingleStrategyPct ?? 30,
      maxTotalExposurePct: fundCfg.maxTotalExposurePct ?? 70,
      rebalanceFrequency: fundCfg.rebalanceFrequency ?? "weekly",
    };

    const fundManager = new FundManager(
      api.resolvePath("state/findoo-fund-state.json"),
      fundConfig,
    );
    const perfStore = new PerformanceSnapshotStore(
      api.resolvePath("state/findoo-performance-snapshots.sqlite"),
    );
    const flowStore = new CapitalFlowStore(api.resolvePath("state/findoo-capital-flows.sqlite"));

    api.registerService({
      id: "fin-fund-manager",
      instance: fundManager,
      start() {
        const equity = fundConfig.totalCapital ?? 100000;
        fundManager.markDayStart(equity);
      },
    } as Parameters<typeof api.registerService>[0]);

    // Getter helpers for lazy service lookup
    const getRegistry = () =>
      (runtime.services?.get?.("fin-strategy-registry") as { instance?: unknown } | undefined)
        ?.instance as Parameters<typeof registerFundTools>[1]["getRegistry"] extends () => infer R
        ? R
        : never;
    const getPaper = () =>
      (runtime.services?.get?.("fin-paper-engine") as { instance?: unknown } | undefined)
        ?.instance as Parameters<typeof registerFundTools>[1]["getPaper"] extends () => infer R
        ? R
        : never;

    const fundDeps = {
      manager: fundManager,
      config: fundConfig,
      flowStore,
      perfStore,
      getRegistry,
      getPaper,
      getDataProvider: () => {
        try {
          return runtime.services?.get?.("fin-data-provider") as Parameters<
            typeof registerFundTools
          >[1]["getDataProvider"] extends () => infer R
            ? R extends undefined
              ? never
              : R
            : never | undefined;
        } catch {
          return undefined;
        }
      },
      getLiveExecutor: () =>
        liveExecutor as Parameters<
          typeof registerFundTools
        >[1]["getLiveExecutor"] extends () => infer R
          ? R extends undefined
            ? never
            : R
          : never,
      getRegimeDetector: () => {
        try {
          return runtime.services?.get?.("fin-regime-detector") as
            | { detect: (ohlcv: unknown[]) => string }
            | undefined;
        } catch {
          return undefined;
        }
      },
    };

    // ── Register fund AI tools (7 tools) ──

    registerFundTools(api, fundDeps);

    // ── Register fund HTTP routes + SSE + bot commands + CLI ──

    registerFundRoutes(api, fundDeps);

    // ── L3 Live Health Monitor (circuit breaker for cumulative loss) ──

    const liveHealthMonitor = new LiveHealthMonitor({
      liveExecutor,
      strategyRegistry,
      eventStore,
      activityLog,
      wakeBridge,
      riskController,
    });

    // ── L3 Live Reconciler (position drift detection: live vs paper) ──

    // P2-1: reconciler thresholds configurable from financial config
    const reconcilerCfg = (financialConfig?.reconciler ?? {}) as Record<string, unknown>;
    const liveReconciler = new LiveReconciler({
      liveExecutor,
      paperEngine,
      strategyRegistry,
      eventStore,
      activityLog,
      wakeBridge,
      thresholds: {
        ...(typeof reconcilerCfg.warningDriftPct === "number"
          ? { warningDriftPct: reconcilerCfg.warningDriftPct }
          : {}),
        ...(typeof reconcilerCfg.criticalDriftPct === "number"
          ? { criticalDriftPct: reconcilerCfg.criticalDriftPct }
          : {}),
      },
    });

    // ── Lifecycle Engine (autonomous promotion/demotion, runs every 5 min) ──

    const lifecycleEngine = new LifecycleEngine(
      {
        strategyRegistry,
        fundManagerResolver: () => fundManager,
        paperEngine,
        eventStore,
        activityLog,
        wakeBridge:
          wakeBridge ??
          new AgentWakeBridge({
            enqueueSystemEvent: () => {},
            sessionKeyResolver: () => undefined,
            activityLog,
          }),
        liveHealthMonitor,
        liveReconciler,
        alertEngine,
        exchangeRegistry: registry,
        exchangeHealthStore: healthStore,
        garbageCollector: {
          collect(profiles: Parameters<GarbageCollector["collect"]>[0]) {
            return gcRef.gc?.collect(profiles) ?? { killed: [], reasons: new Map() };
          },
        },
        dataProvider: {
          async getTicker(symbol: string, market: string) {
            try {
              const svc = runtime.services?.get?.("fin-data-provider") as
                | {
                    getTicker?: (
                      symbol: string,
                      market: string,
                    ) => Promise<{ close?: number } | null>;
                  }
                | undefined;
              return (await svc?.getTicker?.(symbol, market)) ?? null;
            } catch {
              return null;
            }
          },
        },
      },
      5 * 60_000, // 5 minutes
    );
    lifecycleEngine.start();
    lifecycleRef.engine = lifecycleEngine;

    // ── Health Probe (P1-1: external liveness endpoint) ──

    const healthProbe = new HealthProbe({
      healthStore,
      riskController,
      lifecycleEngineResolver: () => lifecycleRef.engine,
      orderTracker,
    });
    healthProbe.startHeartbeatWriter(api.resolvePath("state/heartbeat.json"));

    api.registerHttpRoute({
      auth: "gateway",
      path: "/api/v1/finance/health",
      handler: async (_req: unknown, res: unknown) => {
        const httpRes = res as import("./src/types-http.js").HttpRes;
        const result = healthProbe.check();
        const statusCode = result.status === "unhealthy" ? 503 : 200;
        httpRes.writeHead(statusCode, { "Content-Type": "application/json" });
        httpRes.end(JSON.stringify(result));
      },
    });

    // ── Paper Health Monitor (rules layer: detect conditions → emit events → LLM decides) ──

    const healthMonitor = new PaperHealthMonitor({
      eventStore,
      paperEngine,
      wakeBridge,
    });

    // ── Paper Scheduler (auto-tick L2_PAPER strategies) ──

    const paperScheduler = new PaperScheduler({
      paperEngine,
      strategyRegistry,
      healthMonitor,
      wakeBridge,
      tickIntervalMs: 60_000,
      snapshotIntervalMs: 3_600_000,
      serviceResolver: () => {
        try {
          return runtime.services?.get?.("fin-data-provider") as
            | typeof paperScheduler.deps.dataProvider
            | undefined;
        } catch {
          return undefined;
        }
      },
      regimeDetectorResolver: () => {
        try {
          return runtime.services?.get?.("fin-regime-detector") as
            | { detect: (ohlcv: unknown[]) => string }
            | undefined;
        } catch {
          return undefined;
        }
      },
      fundManagerResolver: () => {
        try {
          const svc = runtime.services?.get?.("fin-fund-manager") as
            | { instance?: unknown }
            | undefined;
          return svc?.instance as typeof paperScheduler.deps extends {
            fundManagerResolver?: () => infer R;
          }
            ? R
            : never;
        } catch {
          return undefined;
        }
      },
    });
    paperScheduler.start();

    // ── Daily Brief Scheduler ──

    const briefScheduler = new DailyBriefScheduler({
      paperEngine,
      strategyRegistry,
      eventStore,
      wakeBridge,
      liveExecutor,
      intervalMs: 86_400_000, // 24 hours
    });
    // DailyBrief timer removed — now triggered by OpenClaw cron (findoo:daily-brief)

    // ── Strategy Ideation Scheduler (market scan → LLM → auto-create strategies) ──

    const ideationUserConfig = (
      (api.config as Record<string, unknown>)?.financial as Record<string, unknown> | undefined
    )?.ideation as Partial<IdeationConfig> | undefined;

    const ideationConfig: IdeationConfig = {
      ...DEFAULT_IDEATION_CONFIG,
      ...ideationUserConfig,
    };

    const marketScanner = new MarketScanner({
      dataProviderResolver: () => {
        try {
          const svc = runtime.services?.get?.("fin-data-provider");
          return svc as import("./src/ideation/market-scanner.js").DataProviderLike | undefined;
        } catch {
          return undefined;
        }
      },
      regimeDetectorResolver: () => {
        try {
          const svc = runtime.services?.get?.("fin-regime-detector");
          return svc as import("./src/ideation/market-scanner.js").RegimeDetectorLike | undefined;
        } catch {
          return undefined;
        }
      },
    });

    const dedupFilter = new DeduplicationFilter(strategyRegistry);

    // Create FailureFeedbackStore early so ideationScheduler can reference it
    const failureFeedbackStore = new FailureFeedbackStore();

    const ideationEngine = new IdeationEngine({
      wakeBridge,
      activityLog,
    });

    const ideationScheduler = new IdeationScheduler(
      {
        scanner: marketScanner,
        engine: ideationEngine,
        filter: dedupFilter,
        activityLog,
        existingStrategyNamesResolver: () => {
          try {
            return strategyRegistry
              .list()
              .map((s) => `${s.name} (${s.definition.symbols.join(",")})`);
          } catch {
            return [];
          }
        },
        maxConcurrentResolver: () => {
          try {
            return agentConfigStore.get().maxConcurrentStrategies ?? 20;
          } catch {
            return 20;
          }
        },
        failureFeedbackResolver: () => {
          try {
            return failureFeedbackStore.getSummary();
          } catch {
            return "";
          }
        },
      },
      ideationConfig,
    );
    // Ideation timer removed — now triggered by OpenClaw cron (findoo:ideation-scan)
    ideationRef.scheduler = ideationScheduler;

    // ── Cold-Start Seeder (seeds 10 strategies on first launch) ──
    // Creates seed strategies at L0 and promotes to L1. The LLM agent handles
    // all further lifecycle decisions (backtests, promotions, demotions) via
    // HEARTBEAT.md checklist + fin_* AI tools.

    const coldStartSeeder = new ColdStartSeeder({
      strategyRegistry,
      bridge: backtestBridge,
      eventStore,
      wakeBridge,
    });
    setTimeout(() => void coldStartSeeder.maybeSeed(), 500);

    // ── Alpha Factory (S1-S6 pipeline) ──

    const screeningPipeline = new ScreeningPipeline({
      backtestService: {
        async runBacktest(params: { strategyId: string; months?: number }) {
          try {
            const svc = runtime.services?.get?.("fin-remote-backtest") as
              | { runBacktest?: (p: { strategyId: string; months?: number }) => Promise<unknown> }
              | undefined;
            return (await svc?.runBacktest?.(params)) as
              | import("./src/shared/types.js").BacktestResult
              | null;
          } catch {
            return null;
          }
        },
      },
    });

    const garbageCollector = new GarbageCollector();
    gcRef.gc = garbageCollector;

    const evolutionScheduler = new EvolutionScheduler(
      {
        strategyRegistry,
        evolutionEngineResolver: () => {
          try {
            const svc = runtime.services?.get?.("fin-evolution-engine");
            return svc as
              | { runRdavdCycle?: (id: string) => Promise<{ evolved: boolean; reason: string }> }
              | undefined;
          } catch {
            return undefined;
          }
        },
        paperEngine,
        activityLog,
        wakeBridge,
      },
      86_400_000, // 24h
    );

    const alphaFactory = new AlphaFactoryOrchestrator({
      screeningPipeline,
      evolutionScheduler,
      garbageCollector,
      activityLog,
      onFailure: (strategyId, stage, reason) => {
        const s = strategyRegistry.get(strategyId);
        failureFeedbackStore.record({
          templateId: s?.name ?? strategyId,
          symbol: s?.definition?.symbols?.[0] ?? "unknown",
          failStage: stage as "screening" | "validation" | "paper" | "gc",
          failReason: reason,
          parameters: s?.definition?.parameters ?? {},
          timestamp: Date.now(),
        });
      },
    });
    alphaFactory.start();

    api.registerService({
      id: "fin-alpha-factory",
      start: () => {},
      instance: alphaFactory,
    } as Parameters<typeof api.registerService>[0]);

    // Alpha Factory AI tools
    api.registerTool({
      name: "fin_alpha_factory_run",
      description: "Trigger the Alpha Factory screening pipeline on specified strategies",
      parameters: {
        type: "object" as const,
        properties: {
          strategyIds: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "Strategy IDs to screen",
          },
        },
        required: ["strategyIds"],
      },
      handler: async (params: { strategyIds: string[] }) => {
        const result = await alphaFactory.runScreening(params.strategyIds);
        return { text: JSON.stringify(result, null, 2) };
      },
    } as Parameters<typeof api.registerTool>[0]);

    api.registerTool({
      name: "fin_alpha_factory_status",
      description: "Get Alpha Factory pipeline statistics (funnel data across all stages)",
      parameters: { type: "object" as const, properties: {} },
      handler: async () => {
        return { text: JSON.stringify(alphaFactory.getStats(), null, 2) };
      },
    } as Parameters<typeof api.registerTool>[0]);

    // ── Cron Integration (replaces setInterval for day-level schedulers) ──

    // Shared cron job definitions for findoo day-level tasks
    type CronJobDef = {
      name: string;
      schedule: { kind: "cron"; expr: string; tz?: string };
      payload: { kind: "systemEvent"; text: string };
    };

    const cronJobDefs: CronJobDef[] = [
      {
        name: "findoo:daily-brief",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        payload: {
          kind: "systemEvent",
          text: "[findoo-trader] Morning brief time. Call fin_fund_status to get portfolio data, compose a brief summary, and send to user via message_send.",
        },
      },
      {
        name: "findoo:ideation-scan",
        schedule: { kind: "cron", expr: "0 10 * * *" },
        payload: {
          kind: "systemEvent",
          text: "[findoo-trader] Ideation scan time. Call fin_ideation_trigger to scan markets and generate strategy ideas.",
        },
      },
      {
        name: "findoo:evolution-check",
        schedule: { kind: "cron", expr: "0 12 * * *" },
        payload: {
          kind: "systemEvent",
          text: "[findoo-trader] Alpha decay check time. Call fin_evolution_scan to check for decaying strategies and decide on evolution.",
        },
      },
      {
        name: "findoo:evening-review",
        schedule: { kind: "cron", expr: "0 18 * * *" },
        payload: {
          kind: "systemEvent",
          text: "[findoo-trader] Evening review time. Call fin_leaderboard and fin_list_promotions_ready, compose summary report.",
        },
      },
      {
        name: "findoo:weekly-rebalance",
        schedule: { kind: "cron", expr: "0 10 * * 0" },
        payload: {
          kind: "systemEvent",
          text: "[findoo-trader] Weekly rebalance time. Call fin_fund_rebalance to review 30-day L2 strategies, then fin_leaderboard for weekly report.",
        },
      },
    ];

    // Store cron reference for tools and HTTP routes
    let cronRef:
      | {
          list: (...args: unknown[]) => Promise<unknown[]>;
          add: (input: unknown) => Promise<unknown>;
        }
      | undefined;

    // Helper: idempotently create findoo cron jobs
    async function setupFindooCronJobs(cron: typeof cronRef): Promise<{
      ok: boolean;
      created: number;
      existing: number;
    }> {
      if (!cron) return { ok: false, created: 0, existing: 0 };
      const allJobs = (await cron.list()) as Array<{ name: string }>;
      const findooJobs = allJobs.filter((j) => j.name.startsWith("findoo:"));
      let created = 0;
      for (const def of cronJobDefs) {
        if (!findooJobs.some((j) => j.name === def.name)) {
          await cron.add({
            ...def,
            enabled: true,
            sessionTarget: "main",
            wakeMode: "now",
            delivery: { mode: "none" },
          });
          created++;
        }
      }
      return { ok: true, created, existing: findooJobs.length };
    }

    // Gateway method: access CronService via context.cron
    api.registerGatewayMethod("findoo-trader.cron.setup", async ({ context, respond }) => {
      cronRef = context.cron;
      const result = await setupFindooCronJobs(cronRef);
      respond(true, result);
    });

    // Cron AI tools
    api.registerTool({
      name: "fin_cron_setup",
      description:
        "Initialize or check findoo cron jobs (daily brief, ideation, evolution, evening review, weekly rebalance)",
      parameters: { type: "object" as const, properties: {} },
      handler: async () => {
        if (!cronRef) {
          return {
            text: JSON.stringify({
              error:
                "Cron service not available yet. The gateway method has not been called. Try again after the first heartbeat.",
            }),
          };
        }
        const result = await setupFindooCronJobs(cronRef);
        return { text: JSON.stringify(result, null, 2) };
      },
    } as Parameters<typeof api.registerTool>[0]);

    api.registerTool({
      name: "fin_ideation_trigger",
      description: "Trigger market ideation scan to discover new strategy opportunities",
      parameters: { type: "object" as const, properties: {} },
      handler: async () => {
        const result = await ideationScheduler.runCycle();
        return {
          text: JSON.stringify(
            {
              triggered: true,
              symbolsScanned: result.snapshot.symbols.length,
              created: result.created.length,
              skippedDuplicates: result.skippedDuplicates.length,
            },
            null,
            2,
          ),
        };
      },
    } as Parameters<typeof api.registerTool>[0]);

    api.registerTool({
      name: "fin_evolution_scan",
      description: "Scan L2/L3 strategies for alpha decay and recommend evolution",
      parameters: { type: "object" as const, properties: {} },
      handler: async () => {
        const result = await evolutionScheduler.runCycle();
        return {
          text: JSON.stringify({ scanned: true, ...result }, null, 2),
        };
      },
    } as Parameters<typeof api.registerTool>[0]);

    // Cron HTTP routes for Dashboard
    api.registerHttpRoute({
      auth: "gateway",
      method: "POST",
      path: "/api/v1/finance/cron/setup",
      handler: async (_req: unknown, res: unknown) => {
        const httpRes = res as import("./src/types-http.js").HttpRes;
        const result = await setupFindooCronJobs(cronRef);
        httpRes.writeHead(200, { "Content-Type": "application/json" });
        httpRes.end(JSON.stringify(result));
      },
    });

    api.registerHttpRoute({
      auth: "gateway",
      path: "/api/v1/finance/cron/status",
      handler: async (_req: unknown, res: unknown) => {
        const httpRes = res as import("./src/types-http.js").HttpRes;
        if (!cronRef) {
          httpRes.writeHead(200, { "Content-Type": "application/json" });
          httpRes.end(JSON.stringify({ initialized: false, jobs: [] }));
          return;
        }
        const allJobs = (await cronRef.list()) as Array<{ name: string }>;
        const findooJobs = allJobs.filter((j) => j.name.startsWith("findoo:"));
        httpRes.writeHead(200, { "Content-Type": "application/json" });
        httpRes.end(JSON.stringify({ initialized: true, jobs: findooJobs }));
      },
    });

    // Alpha Factory HTTP routes
    api.registerHttpRoute({
      auth: "gateway",
      path: "/api/v1/finance/alpha-factory/stats",
      handler: async (_req: unknown, res: unknown) => {
        const httpRes = res as import("./src/types-http.js").HttpRes;
        httpRes.writeHead(200, { "Content-Type": "application/json" });
        httpRes.end(JSON.stringify(alphaFactory.getStats()));
      },
    });

    api.registerHttpRoute({
      auth: "gateway",
      path: "/api/v1/finance/alpha-factory/trigger",
      method: "POST",
      handler: async (req: unknown, res: unknown) => {
        const httpRes = res as import("./src/types-http.js").HttpRes;
        const ids = strategyRegistry.list().map((s) => s.id);
        // runFullPipeline internally calls runScreening which triggers onFailure callback
        const result = await alphaFactory.runFullPipeline(ids);
        httpRes.writeHead(200, { "Content-Type": "application/json" });
        httpRes.end(JSON.stringify(result));
      },
    });

    api.registerHttpRoute({
      auth: "gateway",
      path: "/api/v1/finance/alpha-factory/failures",
      handler: async (_req: unknown, res: unknown) => {
        const httpRes = res as import("./src/types-http.js").HttpRes;
        httpRes.writeHead(200, { "Content-Type": "application/json" });
        httpRes.end(
          JSON.stringify({
            summary: failureFeedbackStore.getSummary(),
            recent: failureFeedbackStore.getRecentPatterns(20),
          }),
        );
      },
    });

    // ── Strategy Pack HTTP Routes ──

    registerPackRoutes(api, { strategyRegistry, eventStore, riskController });

    // ── Daily Brief HTTP endpoint ──

    api.registerHttpRoute({
      auth: "gateway",
      path: "/api/v1/finance/daily-brief",
      handler: async (_req: unknown, res: unknown) => {
        const httpRes = res as import("./src/types-http.js").HttpRes;
        let brief = briefScheduler.getLastBrief();
        if (!brief) {
          brief = await briefScheduler.generateBrief();
        }
        httpRes.writeHead(200, { "Content-Type": "application/json" });
        httpRes.end(JSON.stringify({ brief }));
      },
    });

    // ── CLI commands for exchange management ──

    api.registerCli(({ program }) => {
      const exchange = program.command("exchange").description("Manage exchange connections");

      exchange
        .command("list")
        .description("List configured exchanges")
        .action(() => {
          const list = registry.listExchanges();
          if (list.length === 0) {
            console.log("No exchanges configured. Run: openfinclaw exchange add <name>");
            return;
          }
          console.log("Configured exchanges:");
          for (const ex of list) {
            console.log(`  ${ex.id} (${ex.exchange}${ex.testnet ? " [testnet]" : ""})`);
          }
        });

      exchange
        .command("add <name>")
        .description("Add an exchange connection")
        .option("--exchange <type>", "Exchange type (binance, okx, bybit, hyperliquid)")
        .option("--api-key <key>", "API key")
        .option("--secret <secret>", "API secret")
        .option("--passphrase <pass>", "API passphrase (OKX)")
        .option("--testnet", "Use testnet/sandbox mode")
        .action((name: string, opts: Record<string, string | boolean | undefined>) => {
          registry.addExchange(name, {
            exchange: (opts.exchange ?? name) as "binance" | "okx" | "bybit" | "hyperliquid",
            apiKey: (opts.apiKey as string) ?? "",
            secret: (opts.secret as string) ?? "",
            passphrase: opts.passphrase as string | undefined,
            testnet: !!opts.testnet,
          });
          console.log(`Exchange "${name}" added${opts.testnet ? " (testnet)" : ""}.`);
        });

      exchange
        .command("remove <name>")
        .description("Remove an exchange connection")
        .action((name: string) => {
          if (registry.removeExchange(name)) {
            console.log(`Exchange "${name}" removed.`);
          } else {
            console.log(`Exchange "${name}" not found.`);
          }
        });
    });

    // ── Notification Router + Telegram Approval ──

    const notificationConfig = (api.pluginConfig as Record<string, unknown> | undefined)
      ?.notifications as Record<string, unknown> | undefined;
    const telegramChatId =
      (notificationConfig?.telegramChatId as string | undefined) ??
      process.env.FINDOO_TELEGRAM_CHAT_ID;
    const telegramBotToken =
      (notificationConfig?.telegramBotToken as string | undefined) ??
      process.env.FINDOO_TELEGRAM_BOT_TOKEN ??
      process.env.TELEGRAM_BOT_TOKEN;

    if (telegramChatId) {
      const notificationRouter = new NotificationRouter(
        eventStore,
        {
          telegramChatId,
          telegramBotToken,
          minLevel:
            (notificationConfig?.minLevel as "critical" | "action_required" | "info") ?? "info",
          suppressTypes: notificationConfig?.suppressTypes as string[] | undefined as never,
        },
        api.runtime.channel.telegram.sendMessageTelegram,
      );
      notificationRouter.start();

      // Register notification stats endpoint
      api.registerHttpRoute({
        auth: "gateway",
        path: "/api/v1/finance/notifications/stats",
        handler: async (_req: unknown, res: unknown) => {
          const httpRes = res as import("./src/types-http.js").HttpRes;
          httpRes.writeHead(200, { "Content-Type": "application/json" });
          httpRes.end(JSON.stringify(notificationRouter.getStats()));
        },
      });
    }

    // Register Telegram approval callback route (always active — handles button clicks)
    registerTelegramApprovalRoute(api, eventStore, {
      telegramBotToken,
      editMessageTelegram: api.runtime.channel.telegram.editMessageTelegram,
      lifecycleEngineResolver: () => lifecycleRef.engine,
    });

    // ── Emergency Stop Bot Commands (/pause + /resume) ──

    api.registerCommand({
      name: "pause",
      description: "Emergency stop — halt all trading immediately",
      acceptsArgs: false,
      handler: async () => {
        riskController.pause();
        let cancelResult = { cancelled: 0, errors: 0 };
        try {
          cancelResult = await liveExecutor.cancelAllOpenOrders();
        } catch {
          /* exchange offline — pause still effective via risk gate */
        }
        eventStore.addEvent({
          type: "alert_triggered" as "alert_triggered",
          title: "Emergency Stop",
          detail: `Trading paused. Cancelled ${cancelResult.cancelled} open orders. Use /resume to restore.`,
          status: "completed",
        });
        activityLog.append({
          category: "decision",
          action: "emergency_pause",
          detail: `Trading paused. Cancelled ${cancelResult.cancelled} orders, ${cancelResult.errors} errors.`,
        });
        return {
          text: `🚨 Trading PAUSED. ${cancelResult.cancelled} orders cancelled. All trading tools blocked until /resume.`,
        };
      },
    });

    api.registerCommand({
      name: "resume",
      description: "Resume trading after emergency stop",
      acceptsArgs: false,
      handler: async () => {
        riskController.resume();
        activityLog.append({
          category: "decision",
          action: "emergency_resume",
          detail: "Trading resumed by user command.",
        });
        return { text: "Trading RESUMED. Risk controls active." };
      },
    });

    // Telegram approval flow: users reply "approve"/"reject" in Telegram chat.
    // Agent heartbeat reads replies → calls fin_fund_promote / fin_fund_reject.
    // No independent polling — all user interaction is Agent-mediated.

    // ── Risk control hook: intercept fin_* trading tool calls ──

    // Tools that move real or simulated money — must pass risk checks.
    const TRADING_TOOLS = new Set([
      // Live execution (real money)
      "fin_place_order",
      "fin_modify_order",
      "fin_set_stop_loss",
      "fin_set_take_profit",
      // Paper trading (simulated money, still risk-governed)
      "fin_paper_order",
      // Fund management (capital allocation / rebalance)
      "fin_fund_rebalance",
      "fin_fund_allocate",
      "fin_fund_promote",
      // Strategy execution tick (triggers paper/live orders)
      "fin_strategy_tick",
    ]);

    api.registerHook(
      "before_tool_call",
      // Handler receives (event: { toolName, params }, ctx) at runtime via plugin hook system.
      // Cast needed because registerHook's static type is InternalHookHandler (void return),
      // but runModifyingHook casts the handler to extract the return value at runtime.
      (async (event: { toolName: string; params: Record<string, unknown> }) => {
        const toolName = event.toolName;
        if (!toolName || !TRADING_TOOLS.has(toolName)) {
          return; // Read-only tools pass through without checks
        }

        const params = event.params ?? {};

        // Estimate USD value from tool parameters.
        // Different tools expose value differently; use best available signal.
        const estimatedValueUsd =
          typeof params.estimatedValueUsd === "number"
            ? params.estimatedValueUsd
            : typeof params.quantity === "number" && typeof params.price === "number"
              ? params.quantity * params.price
              : typeof params.amount === "number" && typeof params.price === "number"
                ? params.amount * params.price
                : typeof params.amountUsd === "number"
                  ? params.amountUsd
                  : typeof params.capitalUsd === "number"
                    ? params.capitalUsd
                    : 0;

        // Build a minimal OrderRequest for the risk controller.
        const orderForRisk: import("./src/types.js").OrderRequest = {
          exchange: (typeof params.exchange === "string"
            ? params.exchange
            : "default") as import("./src/types.js").ExchangeId,
          symbol: typeof params.symbol === "string" ? params.symbol : "UNKNOWN",
          side: (typeof params.side === "string" ? params.side : "buy") as "buy" | "sell",
          type: "market" as const,
          amount:
            typeof params.amount === "number"
              ? params.amount
              : typeof params.quantity === "number"
                ? params.quantity
                : 0,
          leverage: typeof params.leverage === "number" ? params.leverage : undefined,
        };

        const evaluation = riskController.evaluate(orderForRisk, estimatedValueUsd);

        if (evaluation.tier === "reject") {
          // Log the intercept to the activity audit trail
          activityLog.append({
            category: "decision",
            action: "risk_gate_block",
            detail: `Blocked ${toolName}: ${evaluation.reason}`,
            metadata: {
              toolName,
              estimatedValueUsd,
              params: Object.fromEntries(
                Object.entries(params).filter(
                  ([k]) => !k.toLowerCase().includes("secret") && !k.toLowerCase().includes("key"),
                ),
              ),
            },
          });

          return {
            block: true,
            blockReason: `[Risk Gate] ${evaluation.reason}`,
          };
        }

        if (evaluation.tier === "confirm") {
          // Log that confirmation is required — the LLM will see the blockReason
          // and can present it to the user for manual approval.
          activityLog.append({
            category: "decision",
            action: "risk_gate_confirm",
            detail: `Requires confirmation for ${toolName}: ${evaluation.reason}`,
            metadata: { toolName, estimatedValueUsd },
          });

          return {
            block: true,
            blockReason: `[Risk Gate — Confirmation Required] ${evaluation.reason}`,
          };
        }

        // tier === "auto" — allowed, no block
      }) as unknown as Parameters<typeof api.registerHook>[1],
      { name: "fin-risk-gate" },
    );

    // ── Load HEARTBEAT-FINANCIAL.md template (optional, silent on failure) ──

    let heartbeatChecklist: string | undefined;
    try {
      const templatePath = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../docs/reference/templates/HEARTBEAT-FINANCIAL.md",
      );
      heartbeatChecklist = readFileSync(templatePath, "utf-8");
    } catch {
      // Template not found — skip silently
    }

    // ── Prompt context hook: inject financial state into every agent prompt ──

    // ── Compaction recovery: save financial state before context compression ──

    const recoveryFilePath = api.resolvePath("state/compaction-recovery.json");

    api.on("before_compaction", async () => {
      const snapshot: Record<string, unknown> = {
        ts: Date.now(),
        livePositions: [] as unknown[],
        openOrders: [] as unknown[],
        equity: { paper: 0, live: 0 },
        pending: eventStore.listEvents().filter((e) => e.status === "pending"),
        paused: riskController.isPaused(),
      };
      try {
        snapshot.livePositions = await liveExecutor.fetchPositions();
        snapshot.openOrders = await liveExecutor.fetchOpenOrders();
        const bal = await liveExecutor.fetchBalance();
        (snapshot.equity as { live: number }).live = Number(
          (bal as { total?: { USDT?: number } }).total?.USDT ?? 0,
        );
      } catch {
        /* exchange offline — degrade gracefully */
      }
      (snapshot.equity as { paper: number }).paper = paperEngine
        .listAccounts()
        .reduce((s, a) => s + a.equity, 0);

      writeFileSync(recoveryFilePath, JSON.stringify(snapshot, null, 2));
    });

    api.on("before_prompt_build", async (_event, ctx) => {
      const isHeartbeat = ctx?.trigger === "heartbeat" || ctx?.trigger === "cron";
      const context = buildFinancialContext({
        heartbeatChecklist: isHeartbeat ? heartbeatChecklist : undefined,
        paperEngine,
        strategyRegistry,
        riskController,
        exchangeRegistry: registry,
        eventStore,
        lifecycleEngine: lifecycleRef.engine,
        ideationScheduler,
        recoveryFilePath,
      });
      if (!context) return;
      return { prependSystemContext: context };
    });
  },
};

export default findooTraderPlugin;
