import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { AgentEventSqliteStore } from "./src/agent-event-sqlite-store.js";
import type { DataGatheringDeps } from "./src/data-gathering.js";
import { ExchangeHealthStore } from "./src/exchange-health-store.js";
import { ExchangeRegistry } from "./src/exchange-registry.js";
import { RiskController } from "./src/risk-controller.js";
import { registerHttpRoutes } from "./src/route-handlers.js";
import { registerSseRoutes } from "./src/sse-handlers.js";
import { loadDashboardTemplates } from "./src/template-renderer.js";
import { registerPaperTools, registerStrategyTools, registerTradingTools } from "./src/tools/index.js";
import type { RuntimeServices } from "./src/types-http.js";
import type { ExchangeConfig, TradingRiskConfig } from "./src/types.js";

export type { AdapterOrderParams, UnifiedExchangeAdapter } from "./src/adapters/adapter-interface.js";
export { AlpacaAdapter } from "./src/adapters/alpaca-adapter.js";
export { CcxtAdapter } from "./src/adapters/ccxt-adapter.js";
export { FutuAdapter } from "./src/adapters/futu-adapter.js";
export { OpenCtpAdapter } from "./src/adapters/openctp-adapter.js";
export { createAdapter } from "./src/adapters/adapter-factory.js";
export { isMarketOpen, resolveMarket, validateLotSize, getMarketTimezone, getEarlyCloseTime } from "./src/market-rules.js";
export { isHoliday, isHalfDay, getHolidays } from "./src/holiday-calendar.js";
export { AgentEventSqliteStore } from "./src/agent-event-sqlite-store.js";
export { AgentEventStore } from "./src/agent-event-store.js";
export { ExchangeHealthStore } from "./src/exchange-health-store.js";
export { ExchangeRegistry } from "./src/exchange-registry.js";
export { RiskController } from "./src/risk-controller.js";
export * from "./src/types.js";

const DEFAULT_RISK_CONFIG: TradingRiskConfig = {
  enabled: false,
  maxAutoTradeUsd: 100,
  confirmThresholdUsd: 500,
  maxDailyLossUsd: 1000,
  maxPositionPct: 25,
  maxLeverage: 1,
};

const finCorePlugin = {
  id: "fin-core",
  name: "Financial Core",
  description: "Core financial infrastructure: exchange registry, risk controller, shared types",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const registry = new ExchangeRegistry();

    // Pre-load exchanges from config so they're available immediately.
    const financialConfig = api.config?.financial;
    if (financialConfig?.exchanges) {
      for (const [name, cfg] of Object.entries(financialConfig.exchanges)) {
        registry.addExchange(name, cfg as ExchangeConfig);
      }
    }

    // Apply configured risk limits, falling back to safe defaults.
    const tradingCfg = financialConfig?.trading;
    const riskConfig: TradingRiskConfig = {
      ...DEFAULT_RISK_CONFIG,
      ...(tradingCfg?.enabled != null && { enabled: tradingCfg.enabled }),
      ...(tradingCfg?.maxAutoTradeUsd != null && { maxAutoTradeUsd: tradingCfg.maxAutoTradeUsd }),
      ...(tradingCfg?.confirmThresholdUsd != null && {
        confirmThresholdUsd: tradingCfg.confirmThresholdUsd,
      }),
      ...(tradingCfg?.maxDailyLossUsd != null && { maxDailyLossUsd: tradingCfg.maxDailyLossUsd }),
      ...(tradingCfg?.maxPositionPct != null && { maxPositionPct: tradingCfg.maxPositionPct }),
      ...(tradingCfg?.maxLeverage != null && { maxLeverage: tradingCfg.maxLeverage }),
      ...(tradingCfg?.allowedPairs && { allowedPairs: tradingCfg.allowedPairs }),
      ...(tradingCfg?.blockedPairs && { blockedPairs: tradingCfg.blockedPairs }),
    };
    const riskController = new RiskController(riskConfig);

    // Expose services for other fin-* plugins to consume.
    api.registerService({
      id: "fin-exchange-registry",
      start: () => {},
      instance: registry,
    } as Parameters<typeof api.registerService>[0]);

    api.registerService({
      id: "fin-risk-controller",
      start: () => {},
      instance: riskController,
    } as Parameters<typeof api.registerService>[0]);

    // ── Agent Event Store ──

    const eventStore = new AgentEventSqliteStore(api.resolvePath("state/fin-agent-events.sqlite"));
    api.registerService({
      id: "fin-event-store",
      start: () => {},
      instance: eventStore,
    } as Parameters<typeof api.registerService>[0]);

    // ── Exchange Health Store ──

    const healthStore = new ExchangeHealthStore(
      api.resolvePath("state/fin-exchange-health.sqlite"),
    );

    // Pre-populate from configured exchanges
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

    // ── Register all HTTP routes (API + dashboards) ──

    registerHttpRoutes({
      api,
      gatherDeps,
      eventStore,
      healthStore,
      riskController,
      runtime,
      templates,
    });

    // ── Register SSE streams ──

    registerSseRoutes(api, gatherDeps, eventStore);

    // ── Register AI tools (8 tools: trading + paper + strategy) ──

    const exchangeConfigs = new Map<string, ExchangeConfig>();
    if (financialConfig?.exchanges) {
      for (const [name, cfg] of Object.entries(financialConfig.exchanges)) {
        exchangeConfigs.set(name, cfg as ExchangeConfig);
      }
    }

    registerTradingTools(api, registry, riskController, exchangeConfigs);
    registerPaperTools(api);
    registerStrategyTools(api);

    // ── CLI commands for exchange management ──

    api.registerCli(({ program }) => {
      const exchange = program.command("exchange").description("Manage exchange connections");

      exchange
        .command("list")
        .description("List configured exchanges")
        .action(() => {
          const exchanges = registry.listExchanges();
          if (exchanges.length === 0) {
            console.log("No exchanges configured. Run: openfinclaw exchange add <name>");
            return;
          }
          console.log("Configured exchanges:");
          for (const ex of exchanges) {
            console.log(`  ${ex.id} (${ex.exchange}${ex.testnet ? " [testnet]" : ""})`);
          }
        });

      exchange
        .command("add <name>")
        .description("Add an exchange connection")
        .option("--exchange <type>", "Exchange type (binance, okx, bybit, hyperliquid, alpaca, futu)")
        .option("--api-key <key>", "API key")
        .option("--secret <secret>", "API secret")
        .option("--passphrase <pass>", "API passphrase (OKX)")
        .option("--testnet", "Use testnet/sandbox mode")
        .action((name: string, opts: Record<string, string | boolean | undefined>) => {
          registry.addExchange(name, {
            exchange: (opts.exchange ?? name) as ExchangeConfig["exchange"],
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

    // Risk control hook: intercept all fin_* tool calls.
    api.registerHook(
      "before_tool_call",
      async (ctx) => {
        const toolName = (ctx as unknown as Record<string, unknown>).toolName as string | undefined;
        if (
          !toolName ||
          (!toolName.startsWith("fin_place_order") && !toolName.startsWith("fin_modify_order"))
        ) {
          return; // Only gate trading actions.
        }

        // Risk evaluation happens in fin-trading; this hook provides the controller.
        (ctx as unknown as Record<string, unknown>).riskController = riskController;
      },
      { name: "fin-risk-gate" },
    );
  },
};

export default finCorePlugin;
