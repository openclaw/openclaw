/**
 * Live full-chain harness — real DataHub data + real services (no mocks).
 *
 * Key differences from harness.ts:
 *   - Uses real findoo-datahub-plugin (fin-data-provider + fin-regime-detector)
 *   - Captures ALL registered tools into a Map for direct invocation
 *   - Captures wake events for assertion
 *   - All 16+ services are real instances with SQLite/JSON persistence in tmpDir
 *
 * Gate: LIVE=1 env var required.
 */

import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import findooDatahubPlugin from "../../../../findoo-datahub-plugin/index.js";
import { EvolutionScheduler } from "../../../src/alpha-factory/evolution-scheduler.js";
import { GarbageCollector } from "../../../src/alpha-factory/garbage-collector.js";
import { AlphaFactoryOrchestrator } from "../../../src/alpha-factory/orchestrator.js";
import { ScreeningPipeline } from "../../../src/alpha-factory/screening-pipeline.js";
import { ActivityLogStore } from "../../../src/core/activity-log-store.js";
import { AgentEventSqliteStore } from "../../../src/core/agent-event-sqlite-store.js";
import { AgentWakeBridge } from "../../../src/core/agent-wake-bridge.js";
import { AlertEngine } from "../../../src/core/alert-engine.js";
import { JsonConfigStore } from "../../../src/core/config-store.js";
import { DailyBriefScheduler } from "../../../src/core/daily-brief-scheduler.js";
import type { DataGatheringDeps } from "../../../src/core/data-gathering.js";
import { ExchangeHealthStore } from "../../../src/core/exchange-health-store.js";
import { ExchangeRegistry } from "../../../src/core/exchange-registry.js";
import { LifecycleEngine } from "../../../src/core/lifecycle-engine.js";
import { RiskController } from "../../../src/core/risk-controller.js";
import { registerHttpRoutes } from "../../../src/core/route-handlers.js";
import { registerSseRoutes } from "../../../src/core/sse-handlers.js";
import { registerTelegramApprovalRoute } from "../../../src/core/telegram-approval.js";
import { loadDashboardTemplates } from "../../../src/core/template-renderer.js";
import { LiveExecutor } from "../../../src/execution/live-executor.js";
import { LiveHealthMonitor } from "../../../src/execution/live-health-monitor.js";
import { LiveReconciler } from "../../../src/execution/live-reconciler.js";
import { registerTradingTools } from "../../../src/execution/trading-tools.js";
import { CapitalFlowStore } from "../../../src/fund/capital-flow-store.js";
import { FundManager } from "../../../src/fund/fund-manager.js";
import { PerformanceSnapshotStore } from "../../../src/fund/performance-snapshot-store.js";
import { registerFundRoutes } from "../../../src/fund/routes.js";
import { registerFundTools } from "../../../src/fund/tools.js";
import { FailureFeedbackStore } from "../../../src/ideation/failure-feedback-store.js";
import { PaperEngine } from "../../../src/paper/paper-engine.js";
import { PaperStore } from "../../../src/paper/paper-store.js";
import { registerPaperTools } from "../../../src/paper/tools.js";
import { BacktestProgressStore } from "../../../src/strategy/backtest-progress-store.js";
import { RemoteBacktestBridge } from "../../../src/strategy/remote-backtest-bridge.js";
import { StrategyRegistry } from "../../../src/strategy/strategy-registry.js";
import { registerStrategyTools } from "../../../src/strategy/tools.js";
import type { HttpReq, HttpRes, RuntimeServices } from "../../../src/types-http.js";

// ── Constants ──

export const LIVE = process.env.LIVE === "1";
const DEV_KEY = "98ffa5c5-1ec6-4735-8e0c-715a5eca1a8d";

const DEFAULT_RISK_CONFIG = {
  enabled: true,
  maxAutoTradeUsd: 100,
  confirmThresholdUsd: 1000,
  maxDailyLossUsd: 5000,
  maxPositionPct: 20,
  maxLeverage: 10,
};

const DEFAULT_FUND_CONFIG = {
  totalCapital: 100000,
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "weekly" as const,
};

const DEFAULT_GATES = {
  l0l1: { minDays: 7, minSharpe: 0.5, maxDrawdown: -0.2, minWinRate: 0.4, minTrades: 10 },
  l1l2: { minDays: 14, minSharpe: 1.0, maxDrawdown: -0.15, minWinRate: 0.45, minTrades: 30 },
  l2l3: { minDays: 30, minSharpe: 1.5, maxDrawdown: -0.1, minWinRate: 0.5, minTrades: 50 },
};

// ── Types ──

export type ToolExecuteFn = (id: string, params: Record<string, unknown>) => Promise<unknown>;
export type ToolMap = Map<string, { execute: ToolExecuteFn }>;

export type WakeEvent = { text: string; sessionKey: string; contextKey?: string };

export type LiveChainServices = {
  registry: ExchangeRegistry;
  riskController: RiskController;
  eventStore: AgentEventSqliteStore;
  alertEngine: AlertEngine;
  agentConfigStore: JsonConfigStore;
  gateConfigStore: JsonConfigStore;
  healthStore: ExchangeHealthStore;
  liveExecutor: LiveExecutor;
  paperEngine: PaperEngine;
  strategyRegistry: StrategyRegistry;
  backtestBridge: RemoteBacktestBridge;
  progressStore: BacktestProgressStore;
  fundManager: FundManager;
  perfStore: PerformanceSnapshotStore;
  flowStore: CapitalFlowStore;
  briefScheduler: DailyBriefScheduler;
  activityLog: ActivityLogStore;
  lifecycleEngine: LifecycleEngine;
  wakeBridge: AgentWakeBridge;
  liveHealthMonitor: LiveHealthMonitor;
  liveReconciler: LiveReconciler;
  alphaFactory: AlphaFactoryOrchestrator;
  failureFeedbackStore: FailureFeedbackStore;
  dataProvider: unknown; // Real DataHub provider
};

export type LiveChainContext = {
  baseUrl: string;
  server: http.Server;
  services: LiveChainServices;
  runtime: RuntimeServices;
  tools: ToolMap;
  wakeEvents: WakeEvent[];
  tmpDir: string;
  cleanup: () => void;
};

// ── Helpers ──

async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind port");
  const port = addr.port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

export function parseResult(result: unknown): Record<string, unknown> {
  const res = result as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

/** Retry an async fn up to `times` with exponential backoff. */
export async function retry<T>(fn: () => Promise<T>, times = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === times - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

export async function fetchJson(
  url: string,
  opts?: RequestInit,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, { ...opts, redirect: "manual" });
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/html")) {
    return { status: res.status, body: text, headers: res.headers };
  }
  try {
    return { status: res.status, body: JSON.parse(text), headers: res.headers };
  } catch {
    return { status: res.status, body: text, headers: res.headers };
  }
}

export async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(url, { ...init, redirect: "manual" });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

// ── Factory ──

export async function createLiveChainServer(): Promise<LiveChainContext> {
  const tmpDir = join(tmpdir(), `live-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  // ── 1. Register DataHub plugin to get real data provider ──

  const datahubServices = new Map<string, unknown>();
  const datahubTools: ToolMap = new Map();
  const datahubApi = {
    id: "findoo-datahub-plugin",
    name: "findoo-datahub-plugin",
    source: "test",
    config: {},
    pluginConfig: {
      datahubApiKey: process.env.DATAHUB_API_KEY ?? process.env.DATAHUB_PASSWORD ?? DEV_KEY,
    },
    runtime: { version: "test", services: datahubServices },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    log() {},
    registerTool(tool: {
      name: string;
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    }) {
      datahubTools.set(tool.name, tool);
    },
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService(svc: { id: string; instance: unknown }) {
      datahubServices.set(svc.id, svc.instance);
    },
    registerProvider() {},
    registerCommand() {},
    resolvePath: (p: string) => {
      const full = join(tmpDir, "datahub", p);
      mkdirSync(join(full, ".."), { recursive: true });
      return full;
    },
    on() {},
  } as unknown as OpenClawPluginApi;

  await findooDatahubPlugin.register(datahubApi);

  const dataProvider = datahubServices.get("fin-data-provider")!;
  const regimeDetector = datahubServices.get("fin-regime-detector")!;

  // ── 2. Instantiate all trader services ──

  const registry = new ExchangeRegistry();
  const riskController = new RiskController(DEFAULT_RISK_CONFIG);
  const eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
  const alertEngine = new AlertEngine(join(tmpDir, "alerts.sqlite"));
  const agentConfigStore = new JsonConfigStore(join(tmpDir, "agent-config.json"), {
    heartbeatIntervalMs: 60000,
    discoveryEnabled: true,
    evolutionEnabled: false,
    mutationRate: 0.1,
    maxConcurrentStrategies: 5,
  });
  const gateConfigStore = new JsonConfigStore(join(tmpDir, "gate-config.json"), DEFAULT_GATES);
  const healthStore = new ExchangeHealthStore(join(tmpDir, "health.sqlite"));
  const liveExecutor = new LiveExecutor(registry);
  const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
  const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
  const strategyRegistry = new StrategyRegistry(join(tmpDir, "strategies.json"));
  const backtestBridge = new RemoteBacktestBridge(() => undefined);
  const progressStore = new BacktestProgressStore();
  const fundManager = new FundManager(join(tmpDir, "fund-state.json"), DEFAULT_FUND_CONFIG);
  const perfStore = new PerformanceSnapshotStore(join(tmpDir, "perf.sqlite"));
  const flowStore = new CapitalFlowStore(join(tmpDir, "flows.sqlite"));
  const briefScheduler = new DailyBriefScheduler({
    paperEngine,
    strategyRegistry,
    eventStore,
    intervalMs: 86_400_000,
  });
  const activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));

  // Wake events capture
  const wakeEvents: WakeEvent[] = [];
  const wakeBridge = new AgentWakeBridge({
    enqueueSystemEvent: (text: string, options: { sessionKey: string; contextKey?: string }) => {
      wakeEvents.push({ text, ...options });
    },
    sessionKeyResolver: () => "main",
    activityLog,
    dbPath: join(tmpDir, "wake.sqlite"),
  });

  const liveHealthMonitor = new LiveHealthMonitor({
    liveExecutor,
    strategyRegistry: strategyRegistry as never,
    eventStore,
    activityLog,
    wakeBridge,
  });

  const liveReconciler = new LiveReconciler({
    liveExecutor,
    paperEngine: paperEngine as never,
    strategyRegistry: strategyRegistry as never,
    eventStore,
    activityLog,
    wakeBridge,
  });

  const lifecycleEngine = new LifecycleEngine(
    {
      strategyRegistry: strategyRegistry as never,
      fundManagerResolver: () => fundManager as never,
      paperEngine: paperEngine as never,
      eventStore,
      activityLog,
      wakeBridge,
      liveHealthMonitor,
      liveReconciler,
      alertEngine,
      dataProvider: dataProvider as {
        getTicker: (symbol: string, market: string) => Promise<{ close?: number } | null>;
      },
    },
    300_000,
  );

  const failureFeedbackStore = new FailureFeedbackStore();
  const screeningPipeline = new ScreeningPipeline({
    backtestService: {
      async runBacktest() {
        return null;
      },
    },
  });
  const garbageCollector = new GarbageCollector();
  const evolutionScheduler = new EvolutionScheduler(
    { strategyRegistry, evolutionEngineResolver: () => undefined, paperEngine, activityLog },
    86_400_000,
  );
  const alphaFactory = new AlphaFactoryOrchestrator({
    screeningPipeline,
    evolutionScheduler,
    garbageCollector,
    activityLog,
  });
  alphaFactory.start();
  fundManager.markDayStart(DEFAULT_FUND_CONFIG.totalCapital);

  // ── 3. Build serviceMap (mirrors index.ts) ──

  const serviceMap = new Map<string, unknown>();
  serviceMap.set("fin-exchange-registry", registry);
  serviceMap.set("fin-risk-controller", riskController);
  serviceMap.set("fin-event-store", eventStore);
  serviceMap.set("fin-alert-engine", alertEngine);
  serviceMap.set("fin-agent-config", agentConfigStore);
  serviceMap.set("fin-gate-config", gateConfigStore);
  serviceMap.set("fin-exchange-health-store", healthStore);
  serviceMap.set("fin-live-executor", liveExecutor);
  serviceMap.set("fin-paper-engine", paperEngine);
  serviceMap.set("fin-strategy-registry", strategyRegistry);
  serviceMap.set("fin-fund-manager", fundManager);
  serviceMap.set("fin-alpha-factory", alphaFactory);
  // Inject real DataHub services so trader tools can find them via runtime.services
  serviceMap.set("fin-data-provider", dataProvider);
  serviceMap.set("fin-regime-detector", regimeDetector);

  const runtime: RuntimeServices = { services: serviceMap };

  // ── 4. Capture routes + tools via fakeApi ──

  const routes = new Map<string, (req: HttpReq, res: HttpRes) => Promise<void>>();
  const tools: ToolMap = new Map();

  // Merge datahub tools
  for (const [name, tool] of datahubTools) {
    tools.set(name, tool);
  }

  const fakeApi = {
    registerHttpRoute({
      path,
      handler,
    }: {
      path: string;
      handler: (req: HttpReq, res: HttpRes) => Promise<void>;
    }) {
      routes.set(path, handler);
    },
    registerTool(tool: { name: string; execute: ToolExecuteFn }) {
      tools.set(tool.name, tool);
    },
    runtime,
    config: { plugins: { entries: {} } },
    pluginConfig: {},
    resolvePath: (p: string) => join(tmpDir, p),
    registerService: () => {},
    registerCommand: () => {},
    registerCli: () => {},
    registerHook: () => {},
    on: () => {},
  };

  // ── 5. Register all tools ──

  registerTradingTools(fakeApi as never, registry, riskController);
  registerPaperTools(fakeApi as never, paperEngine);
  registerStrategyTools(
    fakeApi as never,
    strategyRegistry,
    backtestBridge,
    liveExecutor,
    paperEngine,
    progressStore,
  );
  registerFundTools(fakeApi as never, {
    manager: fundManager,
    config: DEFAULT_FUND_CONFIG,
    flowStore,
    perfStore,
    getRegistry: () => strategyRegistry as never,
    getPaper: () => paperEngine as never,
    getDataProvider: () => dataProvider as never,
    getLiveExecutor: () => liveExecutor as never,
    getRegimeDetector: () => regimeDetector as never,
  });

  // ── 6. Register HTTP routes ──

  const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "../../../dashboard");
  const templates = loadDashboardTemplates(dashboardDir);

  const gatherDeps: DataGatheringDeps = {
    registry,
    riskConfig: DEFAULT_RISK_CONFIG,
    eventStore,
    runtime,
    pluginEntries: {},
    liveExecutor,
  };

  registerHttpRoutes({
    api: fakeApi as never,
    gatherDeps,
    eventStore,
    healthStore,
    riskController,
    runtime,
    templates,
    registry,
    perfStore,
    lifecycleEngine,
  });

  registerSseRoutes(fakeApi as never, gatherDeps, eventStore, progressStore, activityLog);

  registerFundRoutes(fakeApi as never, {
    manager: fundManager,
    config: DEFAULT_FUND_CONFIG,
    flowStore,
    perfStore,
    getRegistry: () => strategyRegistry as never,
    getPaper: () => paperEngine as never,
  });

  registerTelegramApprovalRoute(fakeApi as never, eventStore, {});

  // Daily brief endpoint
  routes.set("/api/v1/finance/daily-brief", async (_req: unknown, res: unknown) => {
    const httpRes = res as HttpRes;
    let brief = briefScheduler.getLastBrief();
    if (!brief) brief = await briefScheduler.generateBrief();
    httpRes.writeHead(200, { "Content-Type": "application/json" });
    httpRes.end(JSON.stringify({ brief }));
  });

  // ── 7. Boot HTTP server ──

  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const handler = routes.get(url.pathname);
    if (handler) {
      handler(req as unknown as HttpReq, res as unknown as HttpRes).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      });
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;

  const services: LiveChainServices = {
    registry,
    riskController,
    eventStore,
    alertEngine,
    agentConfigStore,
    gateConfigStore,
    healthStore,
    liveExecutor,
    paperEngine,
    strategyRegistry,
    backtestBridge,
    progressStore,
    fundManager,
    perfStore,
    flowStore,
    briefScheduler,
    activityLog,
    lifecycleEngine,
    wakeBridge,
    liveHealthMonitor,
    liveReconciler,
    alphaFactory,
    failureFeedbackStore,
    dataProvider,
  };

  return {
    baseUrl,
    server,
    services,
    runtime,
    tools,
    wakeEvents,
    tmpDir,
    cleanup() {
      try {
        alphaFactory.stop();
      } catch {
        /* noop */
      }
      try {
        evolutionScheduler.stop();
      } catch {
        /* noop */
      }
      try {
        lifecycleEngine.stop();
      } catch {
        /* noop */
      }
      try {
        activityLog.close();
      } catch {
        /* noop */
      }
      try {
        alertEngine.close();
      } catch {
        /* noop */
      }
      try {
        eventStore.close();
      } catch {
        /* noop */
      }
      try {
        healthStore.close();
      } catch {
        /* noop */
      }
      try {
        perfStore.close();
      } catch {
        /* noop */
      }
      try {
        flowStore.close();
      } catch {
        /* noop */
      }
      server.close();
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    },
  };
}
