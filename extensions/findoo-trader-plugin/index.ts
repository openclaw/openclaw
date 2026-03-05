/**
 * findoo-trader-plugin — unified trading infrastructure.
 * Merges fin-core + fin-trading + fin-paper-trading + fin-strategy-engine + fin-fund-manager
 * into a single cohesive plugin.
 *
 * Services: fin-exchange-registry, fin-risk-controller, fin-event-store,
 *           fin-exchange-health-store, fin-live-executor,
 *           fin-paper-engine, fin-strategy-registry, fin-backtest-engine,
 *           fin-fund-manager
 * AI Tools (23): 5 trading + 6 paper + 5 strategy + 7 fund
 * HTTP Routes: 38 (API + dashboards)
 * SSE Streams: 4 (config, trading, events, fund)
 * CLI Commands: exchange list/add/remove, fund pipeline
 * Bot Commands: /fund, /risk, /lb, /alloc, /promote
 * Hooks: before_tool_call risk gate, before_prompt_build financial context
 * Notification: Telegram event routing + inline approval buttons
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
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
import { LifecycleEngine } from "./src/core/lifecycle-engine.js";
import { NotificationRouter } from "./src/core/notification-router.js";
import { buildFinancialContext } from "./src/core/prompt-context.js";
import { RiskController } from "./src/core/risk-controller.js";
import { registerHttpRoutes } from "./src/core/route-handlers.js";
import { registerSseRoutes } from "./src/core/sse-handlers.js";
import { registerTelegramApprovalRoute } from "./src/core/telegram-approval.js";
import { loadDashboardTemplates } from "./src/core/template-renderer.js";
import { LiveExecutor } from "./src/execution/live-executor.js";
import { registerTradingTools } from "./src/execution/trading-tools.js";
import { CapitalFlowStore } from "./src/fund/capital-flow-store.js";
import { ColdStartSeeder } from "./src/fund/cold-start-seeder.js";
import { FundManager } from "./src/fund/fund-manager.js";
import { PerformanceSnapshotStore } from "./src/fund/performance-snapshot-store.js";
import { registerPackRoutes } from "./src/fund/routes-packs.js";
import { registerFundRoutes } from "./src/fund/routes.js";
import { registerFundTools } from "./src/fund/tools.js";
import type { FundConfig } from "./src/fund/types.js";
import { PaperEngine } from "./src/paper/paper-engine.js";
import { PaperHealthMonitor } from "./src/paper/paper-health-monitor.js";
import { PaperScheduler } from "./src/paper/paper-scheduler.js";
import { PaperStore } from "./src/paper/paper-store.js";
import { registerPaperTools } from "./src/paper/tools.js";
import { BacktestEngine } from "./src/strategy/backtest-engine.js";
import { BacktestProgressStore } from "./src/strategy/backtest-progress-store.js";
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
export { RiskController } from "./src/core/risk-controller.js";
export { CcxtBridge, CcxtBridgeError } from "./src/execution/ccxt-bridge.js";
export { PaperEngine } from "./src/paper/paper-engine.js";
export { PaperStore } from "./src/paper/paper-store.js";
export { BacktestEngine } from "./src/strategy/backtest-engine.js";
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
export * from "./src/types.js";

const findooTraderPlugin = {
  id: "findoo-trader-plugin",
  name: "Findoo Trader",
  description:
    "Unified trading infrastructure — exchange registry, risk control, paper trading, strategy engine, fund management",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const { exchanges, riskConfig } = resolveConfig(api);

    // ── Exchange Registry ──

    const registry = new ExchangeRegistry();
    for (const [name, cfg] of Object.entries(exchanges)) {
      registry.addExchange(name, cfg as ExchangeConfig);
    }

    api.registerService({
      id: "fin-exchange-registry",
      start: () => {},
      instance: registry,
    } as Parameters<typeof api.registerService>[0]);

    // ── Risk Controller ──

    const riskController = new RiskController(riskConfig);

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

    // ── Live Executor (NEW — fixes L3_LIVE broken path) ──

    const liveExecutor = new LiveExecutor(registry);

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

    const runtimeSystem = (
      api.runtime as unknown as { system?: { enqueueSystemEvent?: (...args: unknown[]) => void } }
    )?.system;
    const wakeBridge = runtimeSystem?.enqueueSystemEvent
      ? new AgentWakeBridge({
          enqueueSystemEvent: runtimeSystem.enqueueSystemEvent as (
            text: string,
            options: { sessionKey: string; contextKey?: string },
          ) => void,
          sessionKeyResolver: () => {
            // Use "main" session — the heartbeat runner's default session key
            // This is resolved lazily because sessions may not exist at registration time
            try {
              const sessions = (runtime as unknown as { sessions?: Map<string, unknown> }).sessions;
              if (sessions && sessions.size > 0) {
                return sessions.keys().next().value as string;
              }
            } catch {
              // fall through
            }
            return "main";
          },
          activityLog,
        })
      : undefined;

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
    const backtestEngine = new BacktestEngine();

    api.registerService({
      id: "fin-strategy-registry",
      start: () => {},
      instance: strategyRegistry,
    } as Parameters<typeof api.registerService>[0]);

    api.registerService({
      id: "fin-backtest-engine",
      start: () => {},
      instance: backtestEngine,
    } as Parameters<typeof api.registerService>[0]);

    // ── Register strategy AI tools (5 tools, L3 uses liveExecutor directly) ──

    registerStrategyTools(
      api,
      strategyRegistry,
      backtestEngine,
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
    };

    // ── Register fund AI tools (7 tools) ──

    registerFundTools(api, fundDeps);

    // ── Register fund HTTP routes + SSE + bot commands + CLI ──

    registerFundRoutes(api, fundDeps);

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
      },
      5 * 60_000, // 5 minutes
    );
    lifecycleEngine.start();
    lifecycleRef.engine = lifecycleEngine;

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
      intervalMs: 86_400_000, // 24 hours
    });
    briefScheduler.start();

    // ── Cold-Start Seeder (seeds 5 classic strategies on first launch) ──
    // Creates seed strategies at L0 and promotes to L1. The LLM agent handles
    // all further lifecycle decisions (backtests, promotions, demotions) via
    // HEARTBEAT.md checklist + fin_* AI tools.

    const coldStartSeeder = new ColdStartSeeder({
      strategyRegistry,
      backtestEngine,
      eventStore,
      wakeBridge,
      dataProviderResolver: () => {
        try {
          const svc = runtime.services?.get?.("fin-data-provider");
          return svc as import("./src/types-http.js").DataProviderLike | undefined;
        } catch {
          return undefined;
        }
      },
    });
    setTimeout(() => void coldStartSeeder.maybeSeed(), 500);

    // ── Strategy Pack HTTP Routes ──

    registerPackRoutes(api, { strategyRegistry, eventStore });

    // ── Daily Brief HTTP endpoint ──

    api.registerHttpRoute({
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
    const telegramBotToken = notificationConfig?.telegramBotToken as string | undefined;

    if (telegramChatId) {
      const notificationRouter = new NotificationRouter(eventStore, {
        telegramChatId,
        telegramBotToken,
        minLevel:
          (notificationConfig?.minLevel as "critical" | "action_required" | "info") ?? "info",
        suppressTypes: notificationConfig?.suppressTypes as string[] | undefined as never,
      });
      notificationRouter.start();

      // Register notification stats endpoint
      api.registerHttpRoute({
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
      lifecycleEngineResolver: () => lifecycleRef.engine,
    });

    // ── Risk control hook: intercept fin_* trading tool calls ──

    api.registerHook(
      "before_tool_call",
      async (ctx) => {
        const toolName = (ctx as unknown as Record<string, unknown>).toolName as string | undefined;
        if (
          !toolName ||
          (!toolName.startsWith("fin_place_order") && !toolName.startsWith("fin_modify_order"))
        ) {
          return;
        }
        (ctx as unknown as Record<string, unknown>).riskController = riskController;
      },
      { name: "fin-risk-gate" },
    );

    // ── Prompt context hook: inject financial state into every agent prompt ──

    api.on("before_prompt_build", async () => {
      const context = buildFinancialContext({
        paperEngine,
        strategyRegistry,
        riskController,
        exchangeRegistry: registry,
        eventStore,
        lifecycleEngine: lifecycleRef.engine,
      });
      if (!context) return;
      return { prependContext: context };
    });
  },
};

export default findooTraderPlugin;
