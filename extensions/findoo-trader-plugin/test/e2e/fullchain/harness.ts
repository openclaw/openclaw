/**
 * Phase F — Full-chain E2E test harness.
 *
 * Creates ALL 16+ real service instances (no mocks except ccxt/external),
 * registers ALL route handlers into a real node:http server,
 * and exposes the running server + services for tests.
 *
 * Usage:
 *   const ctx = await createFullChainServer();
 *   // ... run tests against ctx.baseUrl ...
 *   ctx.cleanup();
 */

import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvolutionScheduler } from "../../../src/alpha-factory/evolution-scheduler.js";
import { GarbageCollector } from "../../../src/alpha-factory/garbage-collector.js";
import { AlphaFactoryOrchestrator } from "../../../src/alpha-factory/orchestrator.js";
import { ScreeningPipeline } from "../../../src/alpha-factory/screening-pipeline.js";
// ── Service classes ──
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
import { CapitalFlowStore } from "../../../src/fund/capital-flow-store.js";
import { FundManager } from "../../../src/fund/fund-manager.js";
import { PerformanceSnapshotStore } from "../../../src/fund/performance-snapshot-store.js";
import { registerFundRoutes } from "../../../src/fund/routes.js";
import { FailureFeedbackStore } from "../../../src/ideation/failure-feedback-store.js";
import { PaperEngine } from "../../../src/paper/paper-engine.js";
import { PaperStore } from "../../../src/paper/paper-store.js";
import { BacktestProgressStore } from "../../../src/strategy/backtest-progress-store.js";
import { RemoteBacktestBridge } from "../../../src/strategy/remote-backtest-bridge.js";
import { StrategyRegistry } from "../../../src/strategy/strategy-registry.js";
import type { HttpReq, HttpRes, RuntimeServices } from "../../../src/types-http.js";

// ── Default configs (mirroring index.ts defaults) ──

export const DEFAULT_RISK_CONFIG = {
  enabled: true,
  maxAutoTradeUsd: 100,
  confirmThresholdUsd: 1000,
  maxDailyLossUsd: 5000,
  maxPositionPct: 20,
  maxLeverage: 10,
};

export const DEFAULT_AGENT_CONFIG = {
  heartbeatIntervalMs: 60000,
  discoveryEnabled: true,
  evolutionEnabled: false,
  mutationRate: 0.1,
  maxConcurrentStrategies: 5,
};

export const DEFAULT_GATES = {
  l0l1: { minDays: 7, minSharpe: 0.5, maxDrawdown: -0.2, minWinRate: 0.4, minTrades: 10 },
  l1l2: { minDays: 14, minSharpe: 1.0, maxDrawdown: -0.15, minWinRate: 0.45, minTrades: 30 },
  l2l3: { minDays: 30, minSharpe: 1.5, maxDrawdown: -0.1, minWinRate: 0.5, minTrades: 50 },
};

export const DEFAULT_FUND_CONFIG = {
  totalCapital: 100000,
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "weekly" as const,
};

// ── Exported types ──

export type MockDataProvider = {
  prices: Map<string, number>;
  getTicker(symbol: string, market: string): Promise<{ close?: number } | null>;
};

export function createMockDataProvider(): MockDataProvider {
  const prices = new Map<string, number>();
  return {
    prices,
    async getTicker(symbol: string, _market: string) {
      const price = prices.get(symbol);
      return price != null ? { close: price } : null;
    },
  };
}

export type FullChainServices = {
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
  dataProvider: MockDataProvider;
};

export type FullChainContext = {
  baseUrl: string;
  server: http.Server;
  services: FullChainServices;
  runtime: RuntimeServices;
  tmpDir: string;
  cleanup: () => void;
};

// ── Helpers ──

export async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind port");
  const port = addr.port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

export async function fetchJson(
  url: string,
  opts?: RequestInit,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, { ...opts, redirect: "manual" });
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/html")) {
    return { status: res.status, body: await res.text(), headers: res.headers };
  }
  try {
    const body = await res.json();
    return { status: res.status, body, headers: res.headers };
  } catch {
    return { status: res.status, body: await res.text(), headers: res.headers };
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

export async function createFullChainServer(): Promise<FullChainContext> {
  const tmpDir = join(tmpdir(), `phase-f-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  // 1. Instantiate all 16 real services
  const registry = new ExchangeRegistry();
  const riskController = new RiskController(DEFAULT_RISK_CONFIG);
  const eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
  const alertEngine = new AlertEngine(join(tmpDir, "alerts.sqlite"));
  const agentConfigStore = new JsonConfigStore(
    join(tmpDir, "agent-config.json"),
    DEFAULT_AGENT_CONFIG,
  );
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

  const wakeBridge = new AgentWakeBridge({
    enqueueSystemEvent: () => {},
    sessionKeyResolver: () => undefined,
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

  const dataProvider = createMockDataProvider();

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
      dataProvider,
    },
    300_000, // 5 min — won't fire during tests
  );

  // ── Alpha Factory services ──

  const failureFeedbackStore = new FailureFeedbackStore();

  const screeningPipeline = new ScreeningPipeline({
    backtestService: {
      async runBacktest() {
        return null; // No remote backtest in test harness by default
      },
    },
  });

  const garbageCollector = new GarbageCollector();

  const evolutionScheduler = new EvolutionScheduler(
    {
      strategyRegistry,
      evolutionEngineResolver: () => undefined,
      paperEngine,
      activityLog,
    },
    86_400_000, // 24h — won't fire during tests
  );

  const alphaFactory = new AlphaFactoryOrchestrator({
    screeningPipeline,
    evolutionScheduler,
    garbageCollector,
    activityLog,
  });
  alphaFactory.start();

  // Init fund manager day-start
  fundManager.markDayStart(DEFAULT_FUND_CONFIG.totalCapital);

  // 2. Build RuntimeServices map (raw instances — matches route-handlers casting)
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

  const runtime: RuntimeServices = { services: serviceMap };

  // 3. Capture routes via fakeApi
  const routes = new Map<string, (req: HttpReq, res: HttpRes) => Promise<void>>();
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

  // 4. Load dashboard templates
  const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "../../../dashboard");
  const templates = loadDashboardTemplates(dashboardDir);

  // 5. Build DataGatheringDeps
  const gatherDeps: DataGatheringDeps = {
    registry,
    riskConfig: DEFAULT_RISK_CONFIG,
    eventStore,
    runtime,
    pluginEntries: {},
    liveExecutor,
  };

  // 6. Register ALL routes (mirroring index.ts)
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

  // Daily brief endpoint (same as index.ts)
  routes.set("/api/v1/finance/daily-brief", async (_req: unknown, res: unknown) => {
    const httpRes = res as HttpRes;
    let brief = briefScheduler.getLastBrief();
    if (!brief) {
      brief = await briefScheduler.generateBrief();
    }
    httpRes.writeHead(200, { "Content-Type": "application/json" });
    httpRes.end(JSON.stringify({ brief }));
  });

  // ── Alpha Factory HTTP routes (mirroring index.ts) ──

  routes.set("/api/v1/finance/alpha-factory/stats", async (_req: unknown, res: unknown) => {
    const httpRes = res as HttpRes;
    httpRes.writeHead(200, { "Content-Type": "application/json" });
    httpRes.end(JSON.stringify(alphaFactory.getStats()));
  });

  routes.set("/api/v1/finance/alpha-factory/trigger", async (_req: unknown, res: unknown) => {
    const httpRes = res as HttpRes;
    const ids = strategyRegistry.list().map((s) => s.id);
    const result = await alphaFactory.runFullPipeline(ids);
    httpRes.writeHead(200, { "Content-Type": "application/json" });
    httpRes.end(JSON.stringify(result));
  });

  routes.set("/api/v1/finance/alpha-factory/failures", async (_req: unknown, res: unknown) => {
    const httpRes = res as HttpRes;
    httpRes.writeHead(200, { "Content-Type": "application/json" });
    httpRes.end(
      JSON.stringify({
        summary: failureFeedbackStore.getSummary(),
        recent: failureFeedbackStore.getRecentPatterns(20),
      }),
    );
  });

  // 7. Boot real HTTP server
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

  const services: FullChainServices = {
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
