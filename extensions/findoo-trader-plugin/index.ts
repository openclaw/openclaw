/**
 * findoo-trader-plugin — unified trading infrastructure.
 * Merges fin-core + fin-trading + fin-paper-trading + fin-strategy-engine
 * into a single cohesive plugin.
 *
 * Services: fin-exchange-registry, fin-risk-controller, fin-event-store,
 *           fin-exchange-health-store, fin-live-executor,
 *           fin-paper-engine, fin-strategy-registry, fin-backtest-engine
 * AI Tools (16): 5 trading + 6 paper + 5 strategy
 * HTTP Routes: 28 (API + dashboards)
 * SSE Streams: 3 (config, trading, events)
 * CLI Commands: exchange list/add/remove
 * Hook: before_tool_call risk gate
 * Notification: Telegram event routing + inline approval buttons
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { resolveConfig } from "./src/config.js";
import { AgentEventSqliteStore } from "./src/core/agent-event-sqlite-store.js";
import type { DataGatheringDeps } from "./src/core/data-gathering.js";
import { ExchangeHealthStore } from "./src/core/exchange-health-store.js";
import { ExchangeRegistry } from "./src/core/exchange-registry.js";
import { NotificationRouter } from "./src/core/notification-router.js";
import { RiskController } from "./src/core/risk-controller.js";
import { registerHttpRoutes } from "./src/core/route-handlers.js";
import { registerSseRoutes } from "./src/core/sse-handlers.js";
import { registerTelegramApprovalRoute } from "./src/core/telegram-approval.js";
import { loadDashboardTemplates } from "./src/core/template-renderer.js";
import { LiveExecutor } from "./src/execution/live-executor.js";
import { registerTradingTools } from "./src/execution/trading-tools.js";
import { PaperEngine } from "./src/paper/paper-engine.js";
import { PaperStore } from "./src/paper/paper-store.js";
import { registerPaperTools } from "./src/paper/tools.js";
import { BacktestEngine } from "./src/strategy/backtest-engine.js";
import { StrategyRegistry } from "./src/strategy/strategy-registry.js";
import { registerStrategyTools } from "./src/strategy/tools.js";
import type { RuntimeServices } from "./src/types-http.js";
import type { ExchangeConfig } from "./src/types.js";

// Re-exports for external consumers (fin-evolution-engine, fin-monitoring, etc.)
export { AgentEventSqliteStore } from "./src/core/agent-event-sqlite-store.js";
export { AgentEventStore } from "./src/core/agent-event-store.js";
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
    };

    // ── Register HTTP routes (API + dashboards) ──

    registerHttpRoutes({
      api,
      gatherDeps,
      eventStore,
      healthStore,
      riskController,
      runtime,
      templates,
      registry,
    });

    // ── Register SSE streams ──

    registerSseRoutes(api, gatherDeps, eventStore);

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

    registerStrategyTools(api, strategyRegistry, backtestEngine, liveExecutor, paperEngine);

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
    registerTelegramApprovalRoute(api, eventStore, { telegramBotToken });

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
  },
};

export default findooTraderPlugin;
