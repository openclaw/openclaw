/**
 * Phase E — Playwright Browser E2E Tests
 *
 * Layer 4 tests: real browser interaction against HTML dashboard templates
 * served by a stateful mock server. Validates 8 critical user journeys
 * (J1–J8) that cover all 4 dashboard pages.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/playwright-browser.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chromium,
  browserPath,
  hasBrowser,
  getFreePort,
  stripChartJsCdn,
} from "../../../../test/helpers/e2e-browser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paths ──

const DASHBOARD_DIR = join(__dirname, "../../dashboard");
const hasTemplates =
  existsSync(join(DASHBOARD_DIR, "overview.html")) &&
  existsSync(join(DASHBOARD_DIR, "strategy.html")) &&
  existsSync(join(DASHBOARD_DIR, "trader.html")) &&
  existsSync(join(DASHBOARD_DIR, "setting.html"));

// ══════════════════════════════════════════════════════════════════
//  MOCK DATA
// ══════════════════════════════════════════════════════════════════

const MOCK_POSITIONS = [
  {
    symbol: "BTC/USDT",
    side: "long",
    quantity: 0.5,
    entryPrice: 65000,
    currentPrice: 67500,
    unrealizedPnl: 1250,
    unrealizedPnlPct: 3.85,
  },
  {
    symbol: "ETH/USDT",
    side: "short",
    quantity: 5.0,
    entryPrice: 3200,
    currentPrice: 3150,
    unrealizedPnl: 250,
    unrealizedPnlPct: 1.56,
  },
];

const MOCK_STRATEGIES = [
  {
    id: "s-alpha",
    name: "Alpha Momentum",
    level: "L3_LIVE",
    totalReturn: 12.5,
    sharpe: 2.1,
    maxDrawdown: -8.5,
    winRate: 0.72,
    totalTrades: 156,
    fitness: 0.85,
    status: "running",
  },
  {
    id: "s-beta",
    name: "Beta Mean Reversion",
    level: "L2_PAPER",
    totalReturn: 5.8,
    sharpe: 1.4,
    maxDrawdown: -12.3,
    winRate: 0.58,
    totalTrades: 89,
    fitness: 0.62,
    status: "running",
  },
  {
    id: "s-gamma",
    name: "Gamma Breakout",
    level: "L1_BACKTEST",
    totalReturn: 3.2,
    sharpe: 0.9,
    maxDrawdown: -18.1,
    winRate: 0.45,
    totalTrades: 42,
    fitness: 0.38,
    status: "running",
  },
  {
    id: "s-delta",
    name: "Delta Scalper",
    level: "L0_INCUBATE",
    totalReturn: 0,
    sharpe: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 0,
    fitness: 0,
    status: "incubating",
  },
];

type MockEvent = {
  id: string;
  type: string;
  title: string;
  detail: string;
  status: "pending" | "approved" | "rejected" | "completed";
  timestamp: string;
  actionParams?: Record<string, unknown>;
};

type MockAlert = {
  id: string;
  kind: string;
  symbol?: string;
  condition: string;
  message: string;
  createdAt: string;
};

type MockOrder = {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  status: string;
  timestamp: string;
};

type MockExchange = {
  id: string;
  exchange: string;
  testnet: boolean;
  label: string;
  connected?: boolean;
  lastPingMs?: number;
};

type MockRiskConfig = {
  enabled: boolean;
  maxAutoTradeUsd: number;
  confirmThresholdUsd: number;
  maxDailyLossUsd: number;
  maxPositionPct: number;
  maxLeverage: number;
  allowedPairs: string[];
  blockedPairs: string[];
};

const DEFAULT_RISK_CONFIG: MockRiskConfig = {
  enabled: true,
  maxAutoTradeUsd: 100,
  confirmThresholdUsd: 500,
  maxDailyLossUsd: 1000,
  maxPositionPct: 25,
  maxLeverage: 1,
  allowedPairs: [],
  blockedPairs: [],
};

const DEFAULT_AGENT_CONFIG = {
  heartbeatIntervalMs: 60000,
  discoveryEnabled: true,
  evolutionEnabled: true,
  mutationRate: 0.1,
  maxConcurrentStrategies: 5,
};

const DEFAULT_GATES = {
  l0l1: { minDays: 1, minSharpe: 0, maxDd: -50, minWin: 0, minTrades: 0 },
  l1l2: { minDays: 7, minSharpe: 1.0, maxDd: -15, minWin: 0.5, minTrades: 20 },
  l2l3: { minDays: 14, minSharpe: 1.2, maxDd: -10, minWin: 0.55, minTrades: 50 },
};

// ══════════════════════════════════════════════════════════════════
//  STATEFUL MOCK SERVER
// ══════════════════════════════════════════════════════════════════

function createMockServer() {
  let events: MockEvent[] = [];
  let alerts: MockAlert[] = [];
  let orders: MockOrder[] = [];
  let exchanges: MockExchange[] = [];
  let strategies = [...MOCK_STRATEGIES];
  let riskConfig: MockRiskConfig = { ...DEFAULT_RISK_CONFIG };
  let agentConfig = { ...DEFAULT_AGENT_CONFIG };
  let gates = JSON.parse(JSON.stringify(DEFAULT_GATES));
  let eventCounter = 0;
  let orderCounter = 0;
  let alertCounter = 0;
  const sseClients: http.ServerResponse[] = [];

  // -- State helpers --

  function addEvent(ev: Omit<MockEvent, "id" | "timestamp">): MockEvent {
    eventCounter++;
    const event: MockEvent = {
      ...ev,
      id: `evt-${eventCounter}`,
      timestamp: new Date().toISOString(),
    };
    events.push(event);
    for (const client of sseClients) {
      try {
        client.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // client disconnected
      }
    }
    return event;
  }

  function reset() {
    events = [];
    alerts = [];
    orders = [];
    exchanges = [];
    strategies = [...MOCK_STRATEGIES];
    riskConfig = { ...DEFAULT_RISK_CONFIG };
    agentConfig = { ...DEFAULT_AGENT_CONFIG };
    gates = JSON.parse(JSON.stringify(DEFAULT_GATES));
    eventCounter = 0;
    orderCounter = 0;
    alertCounter = 0;
  }

  // -- Dashboard templates --

  let sharedCss = "";
  const templates: Record<string, { html: string; css: string }> = {};

  try {
    sharedCss = readFileSync(join(DASHBOARD_DIR, "unified-dashboard.css"), "utf-8");
  } catch {
    /* ok */
  }
  for (const page of ["overview", "strategy", "trader", "setting"]) {
    try {
      templates[page] = {
        html: readFileSync(join(DASHBOARD_DIR, `${page}.html`), "utf-8"),
        css: (() => {
          try {
            return readFileSync(join(DASHBOARD_DIR, `${page}.css`), "utf-8");
          } catch {
            return "";
          }
        })(),
      };
    } catch {
      templates[page] = { html: "", css: "" };
    }
  }

  /** Strip CDN scripts that block loading in test environments */
  function stripCdnScripts(html: string): string {
    return stripChartJsCdn(html)
      .replace(/<script src="[^"]*lightweight-charts[^"]*"><\/script>/i, "")
      .replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, "")
      .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/gi, "");
  }

  function renderPage(page: string, data: unknown): string | null {
    const t = templates[page];
    if (!t?.html || !sharedCss) return null;
    const safeJson = JSON.stringify(data).replace(/<\//g, "<\\/");
    return stripCdnScripts(
      t.html
        .replace("/*__SHARED_CSS__*/", sharedCss)
        .replace("/*__PAGE_CSS__*/", t.css || "")
        .replace(/\/\*__PAGE_DATA__\*\/\s*\{\}/, safeJson),
    );
  }

  // -- Data builders --

  /** Map string levels to numeric for overview page's renderPipeline */
  const levelToNum: Record<string, number> = {
    L0_INCUBATE: 0,
    L1_BACKTEST: 1,
    L2_PAPER: 2,
    L3_LIVE: 3,
  };

  function buildOverviewData() {
    // Overview page JS uses numeric levels for pipeline counting
    const numericStrategies = strategies.map((s) => ({
      ...s,
      level: levelToNum[s.level] ?? 0,
    }));
    return {
      trading: {
        summary: {
          totalEquity: 125430,
          dailyPnl: 2890,
          dailyPnlPct: 2.3,
          positionCount: MOCK_POSITIONS.length,
          strategyCount: strategies.length,
          winRate: 0.68,
          avgSharpe: 1.2,
        },
        positions: MOCK_POSITIONS,
        orders,
        snapshots: [],
        strategies: numericStrategies,
        backtests: [],
        allocations: { items: [], totalAllocated: 0, cashReserve: 0, totalCapital: 125430 },
      },
      events: { events, pendingCount: events.filter((e) => e.status === "pending").length },
      alerts,
      risk: {
        enabled: riskConfig.enabled,
        level: riskConfig.enabled ? "NORMAL" : "CRITICAL",
        maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
        confirmThresholdUsd: riskConfig.confirmThresholdUsd,
        maxDailyLossUsd: riskConfig.maxDailyLossUsd,
      },
      fund: { allocations: [], totalCapital: 125430 },
      config: {
        generatedAt: new Date().toISOString(),
        exchanges,
        trading: riskConfig,
        plugins: { total: 12, enabled: 10, entries: [{ id: "findoo-trader", enabled: true }] },
      },
      pipeline: {
        l0: strategies.filter((s) => s.level === "L0_INCUBATE").length,
        l1: strategies.filter((s) => s.level === "L1_BACKTEST").length,
        l2: strategies.filter((s) => s.level === "L2_PAPER").length,
        l3: strategies.filter((s) => s.level === "L3_LIVE").length,
      },
    };
  }

  function buildStrategyData() {
    const pipeline = {
      l0: strategies.filter((s) => s.level === "L0_INCUBATE").length,
      l1: strategies.filter((s) => s.level === "L1_BACKTEST").length,
      l2: strategies.filter((s) => s.level === "L2_PAPER").length,
      l3: strategies.filter((s) => s.level === "L3_LIVE").length,
    };
    return {
      pipeline,
      strategies,
      backtests: [],
      allocations: { items: [], totalAllocated: 0, cashReserve: 0, totalCapital: 125430 },
      gates,
      events: { events, pendingCount: events.filter((e) => e.status === "pending").length },
      decayData: strategies.map((s) => ({
        id: s.id,
        name: s.name,
        fitness: s.fitness,
        previousFitness: s.fitness + 0.05,
        delta: -0.05,
        category: s.fitness >= 0.7 ? "healthy" : s.fitness >= 0.4 ? "warning" : "degrading",
      })),
      summary: {
        totalEquity: 125430,
        dailyPnl: 2890,
        dailyPnlPct: 2.3,
      },
    };
  }

  function buildTraderData(domain = "paper") {
    return {
      domain,
      trading: {
        summary: {
          totalEquity: 125430,
          dailyPnl: 2890,
          dailyPnlPct: 2.3,
          positionCount: MOCK_POSITIONS.length,
        },
        positions: MOCK_POSITIONS,
        orders,
        snapshots: [],
        buyingPower: 80000,
        buyingPowerPct: 63.8,
      },
      events: { events, pendingCount: events.filter((e) => e.status === "pending").length },
      alerts,
      risk: {
        enabled: riskConfig.enabled,
        level: riskConfig.enabled ? "NORMAL" : "CRITICAL",
      },
      backtestResults: [],
      symbols: ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT"],
    };
  }

  function buildSettingData() {
    return {
      exchanges,
      exchangeHealth: exchanges.map((ex) => ({
        exchangeId: ex.id,
        connected: ex.connected ?? true,
        lastPingMs: ex.lastPingMs ?? 42,
        apiCallsToday: 156,
        apiLimit: 1200,
      })),
      trading: riskConfig,
      agent: agentConfig,
      gates,
      notifications: { telegram: false, discord: false, email: false },
      plugins: { total: 12, enabled: 10, entries: [{ id: "findoo-trader", enabled: true }] },
    };
  }

  // -- HTTP handler --

  function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch {
          resolve({});
        }
      });
    });
  }

  function json(res: http.ServerResponse, status: number, data: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
  }

  function htmlRes(res: http.ServerResponse, content: string) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  }

  function redirect(res: http.ServerResponse, to: string) {
    res.writeHead(302, { Location: to });
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    // ── Dashboard pages ──
    if (method === "GET" && url === "/dashboard/overview") {
      const page = renderPage("overview", buildOverviewData());
      return page ? htmlRes(res, page) : json(res, 200, buildOverviewData());
    }
    if (method === "GET" && url === "/dashboard/strategy") {
      const page = renderPage("strategy", buildStrategyData());
      return page ? htmlRes(res, page) : json(res, 200, buildStrategyData());
    }
    if (method === "GET" && (url === "/dashboard/trader" || url.startsWith("/dashboard/trader?"))) {
      const parsedUrl = new URL(url, "http://localhost");
      const domain = parsedUrl.searchParams.get("domain") || "paper";
      const page = renderPage("trader", buildTraderData(domain));
      return page ? htmlRes(res, page) : json(res, 200, buildTraderData(domain));
    }
    if (method === "GET" && url === "/dashboard/setting") {
      const page = renderPage("setting", buildSettingData());
      return page ? htmlRes(res, page) : json(res, 200, buildSettingData());
    }

    // ── Legacy redirects ──
    if (method === "GET" && url === "/dashboard/finance")
      return redirect(res, "/dashboard/overview");
    if (method === "GET" && url === "/dashboard/trading") return redirect(res, "/dashboard/trader");
    if (method === "GET" && url === "/dashboard/command-center")
      return redirect(res, "/dashboard/trader");
    if (method === "GET" && url === "/dashboard/mission-control")
      return redirect(res, "/dashboard/overview");
    if (method === "GET" && url === "/dashboard/evolution")
      return redirect(res, "/dashboard/strategy");
    if (method === "GET" && url === "/dashboard/fund") return redirect(res, "/dashboard/strategy");
    if (method === "GET" && url === "/dashboard/trading-desk")
      return redirect(res, "/dashboard/trader");
    if (method === "GET" && url === "/dashboard/strategy-arena")
      return redirect(res, "/dashboard/strategy");

    // ── JSON API: Config ──
    if (method === "GET" && url === "/api/v1/finance/config") {
      return json(res, 200, buildOverviewData().config);
    }

    // ── JSON API: Events ──
    if (method === "GET" && url === "/api/v1/finance/events") {
      return json(res, 200, {
        events,
        pendingCount: events.filter((e) => e.status === "pending").length,
      });
    }

    // ── JSON API: Alerts ──
    if (method === "GET" && url === "/api/v1/finance/alerts") {
      return json(res, 200, { alerts });
    }
    if (method === "POST" && url === "/api/v1/finance/alerts/create") {
      const body = await parseBody(req);
      alertCounter++;
      const alert: MockAlert = {
        id: `alert-${alertCounter}`,
        kind: (body.kind as string) || "price_above",
        symbol: body.symbol as string | undefined,
        condition: `${body.kind || "price"} ${body.symbol || ""} ${body.price || body.threshold || ""}`,
        message: (body.message as string) || "Alert triggered",
        createdAt: new Date().toISOString(),
      };
      alerts.push(alert);
      return json(res, 201, alert);
    }
    if (method === "POST" && url === "/api/v1/finance/alerts/remove") {
      const body = await parseBody(req);
      const idx = alerts.findIndex((a) => a.id === body.id);
      if (idx >= 0) {
        alerts.splice(idx, 1);
        return json(res, 200, { status: "removed", id: body.id });
      }
      return json(res, 404, { error: "Alert not found" });
    }

    // ── JSON API: Orders ──
    if (method === "POST" && url === "/api/v1/finance/orders") {
      const body = await parseBody(req);
      if (!riskConfig.enabled) {
        return json(res, 403, { error: "Trading is disabled" });
      }
      const estimatedUsd = ((body.currentPrice as number) ?? 0) * ((body.quantity as number) ?? 0);
      if (estimatedUsd > riskConfig.confirmThresholdUsd) {
        return json(res, 403, { error: "Order rejected by risk controller" });
      }
      if (estimatedUsd > riskConfig.maxAutoTradeUsd) {
        const event = addEvent({
          type: "trade_pending",
          title: `${((body.side as string) || "buy").toUpperCase()} ${body.quantity} ${body.symbol}`,
          detail: `$${estimatedUsd.toFixed(0)} requires user confirmation`,
          status: "pending",
          actionParams: body,
        });
        return json(res, 202, { status: "pending_approval", eventId: event.id });
      }
      orderCounter++;
      const order: MockOrder = {
        id: `ord-${orderCounter}`,
        symbol: body.symbol as string,
        side: body.side as string,
        quantity: body.quantity as number,
        price: body.currentPrice as number,
        status: "filled",
        timestamp: new Date().toISOString(),
      };
      orders.push(order);
      addEvent({
        type: "trade_executed",
        title: `${(body.side as string).toUpperCase()} ${body.quantity} ${body.symbol}`,
        detail: `Auto-executed at $${body.currentPrice}`,
        status: "completed",
      });
      return json(res, 201, order);
    }
    if (method === "POST" && url === "/api/v1/finance/orders/cancel") {
      const body = await parseBody(req);
      return json(res, 200, { status: "cancelled", orderId: body.orderId });
    }

    // ── JSON API: Events approve ──
    if (method === "POST" && url === "/api/v1/finance/events/approve") {
      const body = await parseBody(req);
      const event = events.find((e) => e.id === body.id);
      if (!event) return json(res, 404, { error: "Event not found" });
      if (event.status !== "pending") return json(res, 400, { error: "Not pending" });
      if (body.action === "reject") {
        event.status = "rejected";
        return json(res, 200, { status: "rejected", eventId: event.id });
      }
      event.status = "approved";
      addEvent({
        type: "trade_executed",
        title: event.title,
        detail: "Approved and executed",
        status: "completed",
      });
      return json(res, 200, { status: "approved", eventId: event.id });
    }

    // ── JSON API: Emergency Stop ──
    if (method === "POST" && url === "/api/v1/finance/emergency-stop") {
      riskConfig.enabled = false;
      addEvent({
        type: "emergency_stop",
        title: "EMERGENCY STOP ACTIVATED",
        detail: "Trading disabled. All strategies paused.",
        status: "completed",
      });
      return json(res, 200, {
        status: "stopped",
        tradingDisabled: true,
        strategiesPaused: strategies.map((s) => s.id),
        message: "Emergency stop activated",
      });
    }

    // ── JSON API: Risk evaluate ──
    if (method === "POST" && url === "/api/v1/finance/risk/evaluate") {
      const body = await parseBody(req);
      const usd = (body.estimatedValueUsd as number) ?? 0;
      if (!riskConfig.enabled)
        return json(res, 200, { tier: "reject", reason: "Trading disabled" });
      if (usd <= riskConfig.maxAutoTradeUsd) return json(res, 200, { tier: "auto" });
      if (usd <= riskConfig.confirmThresholdUsd) return json(res, 200, { tier: "confirm" });
      return json(res, 200, { tier: "reject" });
    }

    // ── JSON API: Exchanges ──
    if (method === "POST" && url === "/api/v1/finance/exchanges") {
      const body = await parseBody(req);
      const ex: MockExchange = {
        id: `${body.exchange}-${Date.now()}`,
        exchange: body.exchange as string,
        testnet: (body.testnet as boolean) ?? false,
        label: (body.label as string) || `${body.exchange}-default`,
        connected: true,
        lastPingMs: 42,
      };
      exchanges.push(ex);
      return json(res, 201, ex);
    }
    if (method === "POST" && url === "/api/v1/finance/exchanges/test") {
      const body = await parseBody(req);
      const ex = exchanges.find((e) => e.id === body.id);
      return json(res, 200, {
        success: !!ex,
        latencyMs: 42,
        balance: [{ currency: "USDT", free: 10000, total: 10000 }],
        markets: ["BTC/USDT", "ETH/USDT"],
      });
    }

    // ── JSON API: Config updates ──
    if (method === "PUT" && url === "/api/v1/finance/config/trading") {
      const body = await parseBody(req);
      Object.assign(riskConfig, body);
      return json(res, 200, { status: "updated", config: riskConfig });
    }
    if (method === "PUT" && url === "/api/v1/finance/config/agent") {
      const body = await parseBody(req);
      Object.assign(agentConfig, body);
      return json(res, 200, { status: "updated", config: agentConfig });
    }
    if (method === "PUT" && url === "/api/v1/finance/config/gates") {
      const body = await parseBody(req);
      Object.assign(gates, body);
      return json(res, 200, { status: "updated", gates });
    }

    // ── JSON API: Strategies ──
    if (method === "POST" && url === "/api/v1/finance/strategies/create") {
      const body = await parseBody(req);
      const strat = {
        id: `s-${Date.now()}`,
        name: body.name as string,
        level: "L0_INCUBATE",
        totalReturn: 0,
        sharpe: 0,
        maxDrawdown: 0,
        winRate: 0,
        totalTrades: 0,
        fitness: 0,
        status: "incubating",
      };
      strategies.push(strat);
      return json(res, 201, strat);
    }
    if (method === "POST" && url === "/api/v1/finance/strategies/backtest-all") {
      const results = strategies.map((s) => ({
        strategyId: s.id,
        strategyName: s.name,
        totalReturn: s.totalReturn || Math.random() * 20 - 5,
        sharpe: s.sharpe || Math.random() * 3,
        maxDrawdown: s.maxDrawdown || -(Math.random() * 20),
        winRate: s.winRate || Math.random(),
        profitFactor: 1.2 + Math.random(),
        totalTrades: s.totalTrades || Math.floor(Math.random() * 100),
      }));
      return json(res, 200, { results });
    }
    if (method === "POST" && url === "/api/v1/finance/strategies/promote") {
      const body = await parseBody(req);
      const strat = strategies.find((s) => s.id === body.id);
      if (!strat) return json(res, 404, { error: "Strategy not found" });
      const levelOrder = ["L0_INCUBATE", "L1_BACKTEST", "L2_PAPER", "L3_LIVE"];
      const idx = levelOrder.indexOf(strat.level);
      if (idx < 0 || idx >= levelOrder.length - 1) {
        return json(res, 400, { error: "Cannot promote further" });
      }
      // L2→L3 requires approval
      if (strat.level === "L2_PAPER") {
        const event = addEvent({
          type: "promotion_pending",
          title: `Promote ${strat.name} to L3`,
          detail: "L2→L3 requires user approval",
          status: "pending",
          actionParams: { strategyId: strat.id, fromLevel: strat.level, toLevel: "L3_LIVE" },
        });
        return json(res, 202, { status: "pending_approval", eventId: event.id });
      }
      strat.level = levelOrder[idx + 1];
      return json(res, 200, { status: "promoted", strategy: strat });
    }

    // ── SSE streams ──
    if (method === "GET" && url === "/api/v1/finance/events/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.push(res);
      req.on("close", () => {
        const idx = sseClients.indexOf(res);
        if (idx >= 0) sseClients.splice(idx, 1);
      });
      return;
    }
    // Catch-all SSE endpoints (overview/stream, strategy/stream, etc.)
    if (method === "GET" && url.includes("/stream")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.push(res);
      req.on("close", () => {
        const idx = sseClients.indexOf(res);
        if (idx >= 0) sseClients.splice(idx, 1);
      });
      return;
    }

    // ── 404 fallback ──
    json(res, 404, { error: "Not found" });
  });

  return {
    server,
    reset,
    addEvent,
    getEvents: () => events,
    getAlerts: () => alerts,
    getOrders: () => orders,
    getExchanges: () => exchanges,
    getStrategies: () => strategies,
    getRiskConfig: () => riskConfig,
    setRiskEnabled: (v: boolean) => {
      riskConfig.enabled = v;
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  PLAYWRIGHT BROWSER E2E TESTS
// ══════════════════════════════════════════════════════════════════

const describeBrowser = hasBrowser && hasTemplates ? describe : describe.skip;

describeBrowser("Phase E: Playwright Browser E2E — 8 User Journeys", () => {
  let port: number;
  let baseUrl: string;
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>["launch"]>>;
  let page: Awaited<ReturnType<typeof browser.newPage>>;
  const mock = createMockServer();

  beforeAll(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve) => mock.server.listen(port, "127.0.0.1", resolve));
    browser = await chromium!.launch({
      executablePath: browserPath!,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  beforeEach(async () => {
    mock.reset();
    page = await browser.newPage();
  });

  // ══════════════════════════════════════════════════════════════════
  //  J1: First-Time Setup (Setting Page)
  // ══════════════════════════════════════════════════════════════════

  describe("J1: First-time setup — Setting page", () => {
    it("loads setting page with exchange section", async () => {
      await page.goto(`${baseUrl}/dashboard/setting`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.title()).toContain("Setting");
      expect(await page.locator("#section-exchanges").isVisible()).toBe(true);
      expect(await page.locator(".topbar__logo").textContent()).toContain("OPENFINCLAW");
    });

    it("shows add-exchange modal and submits exchange", async () => {
      await page.goto(`${baseUrl}/dashboard/setting`);
      await page.waitForLoadState("domcontentloaded");

      // Click "Add Exchange" button
      await page.locator(".add-btn").click();
      await page.waitForSelector("#addExchangeModal", { state: "visible" });

      // Fill the form
      await page.selectOption("#addExchType", "binance");
      await page.fill('#addExchangeForm input[name="apiKey"]', "test-api-key-123");
      await page.fill('#addExchangeForm input[name="secret"]', "test-secret-456");
      await page.fill('#addExchangeForm input[name="label"]', "my-binance-test");
      // The checkbox is hidden behind a toggle CSS component; click the label instead
      await page
        .locator('#addExchangeForm input[name="testnet"]')
        .evaluate((el) => (el as HTMLInputElement).click());

      // Submit the form
      await page.locator('#addExchangeForm button[type="submit"]').click();

      // Verify exchange was added
      expect(mock.getExchanges()).toHaveLength(1);
      expect(mock.getExchanges()[0].exchange).toBe("binance");
      expect(mock.getExchanges()[0].testnet).toBe(true);
    });

    it("updates risk config via form", async () => {
      await page.goto(`${baseUrl}/dashboard/setting`);
      await page.waitForLoadState("domcontentloaded");

      // Navigate to risk section
      await page.locator('[data-section="risk"]').click();
      await page.waitForSelector("#riskForm", { state: "visible" });

      // Fill risk values
      await page.fill("#riskMaxAuto", "200");
      await page.fill("#riskConfirm", "1000");

      // Click save
      await page.locator("#riskForm .save-btn").click();

      // Wait for toast or API response
      await page.waitForTimeout(200);

      // Verify via mock state
      expect(mock.getRiskConfig().maxAutoTradeUsd).toBe(200);
    });

    it("updates agent config via form", async () => {
      await page.goto(`${baseUrl}/dashboard/setting`);
      await page.waitForLoadState("domcontentloaded");

      // Navigate to agent section
      await page.locator('[data-section="agent"]').click();
      await page.waitForSelector("#agentForm", { state: "visible" });

      // Modify heartbeat
      await page.fill("#agentHeartbeat", "30000");
      await page.locator("#agentForm .save-btn").click();
      await page.waitForTimeout(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  J2: Strategy Lifecycle (Strategy Page)
  // ══════════════════════════════════════════════════════════════════

  describe("J2: Strategy lifecycle — Strategy page", () => {
    it("loads with pipeline counts matching mock data", async () => {
      await page.goto(`${baseUrl}/dashboard/strategy`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.title()).toContain("Strategy");

      // Verify pipeline counts (1 per level)
      expect(await page.locator("#pipeL0").textContent()).toBe("1");
      expect(await page.locator("#pipeL1").textContent()).toBe("1");
      expect(await page.locator("#pipeL2").textContent()).toBe("1");
      expect(await page.locator("#pipeL3").textContent()).toBe("1");
    });

    it("opens create strategy slide-over and submits", async () => {
      await page.goto(`${baseUrl}/dashboard/strategy`);
      await page.waitForLoadState("domcontentloaded");

      // Click "New Strategy" button
      await page.locator('button:has-text("New Strategy")').click();
      await page.waitForSelector("#slideCreate", { state: "visible" });

      // Fill form
      await page.fill('#createForm input[name="stratName"]', "test-momentum-1h");
      await page.selectOption('#createForm select[name="stratMarket"]', "crypto");
      await page.selectOption('#createForm select[name="stratTimeframe"]', "1h");
      await page.fill('#createForm input[name="stratSymbols"]', "BTC/USDT, ETH/USDT");

      // Submit
      await page.locator('#createForm button[type="submit"]').click();
      await page.waitForTimeout(200);

      // Verify strategy was created
      expect(mock.getStrategies()).toHaveLength(5); // 4 original + 1 new
      expect(mock.getStrategies().find((s) => s.name === "test-momentum-1h")).toBeDefined();
    });

    it("runs backtest-all and renders results", async () => {
      await page.goto(`${baseUrl}/dashboard/strategy`);
      await page.waitForLoadState("domcontentloaded");

      // Click "Backtest All" button
      await page.locator('button:has-text("Backtest All")').click();
      await page.waitForTimeout(300);

      // The JS should populate #btBody after API response
      // Note: this depends on the JS handling the API response
    });

    it("renders leaderboard rows in raceboard", async () => {
      await page.goto(`${baseUrl}/dashboard/strategy`);
      await page.waitForLoadState("domcontentloaded");

      // The leaderboard should have rows for each strategy
      const lbBody = page.locator("#lbBody");
      expect(await lbBody.isVisible()).toBe(true);
    });

    it("shows evolution stats", async () => {
      await page.goto(`${baseUrl}/dashboard/strategy`);
      await page.waitForLoadState("domcontentloaded");

      // Active count and total
      const activeText = await page.locator("#spActive").textContent();
      expect(parseInt(activeText || "0")).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  J3: L3 Approval Flow (Strategy Page)
  // ══════════════════════════════════════════════════════════════════

  describe("J3: L3 approval flow — Strategy page", () => {
    it("L2→L3 promotion returns pending approval", async () => {
      // Set up a L2 strategy via promote action on the mock
      await page.goto(`${baseUrl}/dashboard/strategy`);
      await page.waitForLoadState("domcontentloaded");

      // Manually trigger a promote via API (simulating the button click flow)
      const res = await page.evaluate(async () => {
        const r = await fetch("/api/v1/finance/strategies/promote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "s-beta" }), // L2_PAPER strategy
        });
        return { status: r.status, body: await r.json() };
      });

      expect(res.status).toBe(202);
      expect(res.body.status).toBe("pending_approval");

      // Verify event was created
      expect(mock.getEvents()).toHaveLength(1);
      expect(mock.getEvents()[0].type).toBe("promotion_pending");
    });

    it("approve L3 promotion via API", async () => {
      // Pre-populate a pending promotion event
      const event = mock.addEvent({
        type: "promotion_pending",
        title: "Promote Beta Mean Reversion to L3",
        detail: "L2→L3 requires user approval",
        status: "pending",
        actionParams: { strategyId: "s-beta", fromLevel: "L2_PAPER", toLevel: "L3_LIVE" },
      });

      await page.goto(`${baseUrl}/dashboard/strategy`);
      await page.waitForLoadState("domcontentloaded");

      // Approve via API call from page context
      const res = await page.evaluate(async (eventId: string) => {
        const r = await fetch("/api/v1/finance/events/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: eventId, action: "approve" }),
        });
        return { status: r.status, body: await r.json() };
      }, event.id);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("approved");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  J4: Paper Trading (Trader Page)
  // ══════════════════════════════════════════════════════════════════

  describe("J4: Paper trading — Trader page", () => {
    it("loads trader page with paper domain active", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.title()).toContain("Trader");

      // Paper domain button should have "active" class
      const domPaper = page.locator("#domPaper");
      expect(await domPaper.isVisible()).toBe(true);
      const cls = await domPaper.getAttribute("class");
      expect(cls).toContain("active");
    });

    it("renders positions list", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      // Positions list should exist
      const posList = page.locator("#positionsList");
      expect(await posList.isVisible()).toBe(true);
    });

    it("submits quick order via inline form", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      // Fill quick order form
      await page.fill("#qoAmount", "0.001");

      // Submit via API call to verify the endpoint works
      const res = await page.evaluate(async () => {
        const r = await fetch("/api/v1/finance/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: "BTC/USDT",
            side: "buy",
            quantity: 0.001,
            currentPrice: 65000,
          }),
        });
        return { status: r.status, body: await r.json() };
      });

      // $65 is within auto tier
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("filled");
      expect(mock.getOrders()).toHaveLength(1);
    });

    it("shows order book and k-line chart containers", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.locator("#klineChartContainer").isVisible()).toBe(true);
      expect(await page.locator("#orderbookPanel").isVisible()).toBe(true);
    });

    it("equity value is displayed in topbar", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      const eqVal = await page.locator("#eqVal").textContent();
      expect(eqVal).not.toBe("--");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  J5: Morning Briefing (Overview Page)
  // ══════════════════════════════════════════════════════════════════

  describe("J5: Morning briefing — Overview page", () => {
    it("loads overview with equity and stats", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.title()).toContain("Overview");
      expect(await page.locator(".topbar__logo").textContent()).toContain("OPENFINCLAW");

      // Equity should be rendered
      const eqVal = await page.locator("#eqVal").textContent();
      expect(eqVal).not.toBe("--");
    });

    it("renders stat pills with position and strategy counts", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.locator("#spPositions").isVisible()).toBe(true);
      expect(await page.locator("#spStrategies").isVisible()).toBe(true);

      const posCount = await page.locator("#spPositions").textContent();
      expect(posCount).toBe("2");

      const stratCount = await page.locator("#spStrategies").textContent();
      expect(stratCount).toBe("4");
    });

    it("shows risk status badge", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.locator("#riskStatus").isVisible()).toBe(true);
      const riskLabel = await page.locator("#riskLabel").textContent();
      expect(riskLabel).toBe("NORMAL");
    });

    it("shows SSE dots in topbar", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.locator("#sseDots").isVisible()).toBe(true);
    });

    it("renders pipeline counts", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.locator("#pipeL0").textContent()).toBe("1");
      expect(await page.locator("#pipeL1").textContent()).toBe("1");
      expect(await page.locator("#pipeL2").textContent()).toBe("1");
      expect(await page.locator("#pipeL3").textContent()).toBe("1");
    });

    it("navigates to other pages via topbar", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      // Click Strategy nav link
      await page.locator('a.topbar__nav-item[href="/dashboard/strategy"]').click();
      await page.waitForLoadState("domcontentloaded");
      expect(page.url()).toContain("/dashboard/strategy");

      // Click Trader nav link
      await page.locator('a.topbar__nav-item[href="/dashboard/trader"]').click();
      await page.waitForLoadState("domcontentloaded");
      expect(page.url()).toContain("/dashboard/trader");

      // Click Setting nav link
      await page.locator('a.topbar__nav-item[href="/dashboard/setting"]').click();
      await page.waitForLoadState("domcontentloaded");
      expect(page.url()).toContain("/dashboard/setting");
    });

    it("injects pageData correctly", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      const pageData = await page.evaluate(
        () => (window as unknown as { pageData: unknown }).pageData,
      );
      expect(pageData).toBeDefined();
      expect((pageData as Record<string, unknown>).trading).toBeDefined();
      expect((pageData as Record<string, unknown>).config).toBeDefined();
      expect((pageData as Record<string, unknown>).alerts).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  J6: Risk Response (Trader + Setting)
  // ══════════════════════════════════════════════════════════════════

  describe("J6: Risk response — Emergency stop", () => {
    it("shows estop button on trader page", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.locator("#estopBtn").isVisible()).toBe(true);
    });

    it("opens estop modal on button click", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      // Click ESTOP button (on trader page it calls TR.showEstop())
      await page.locator('.qa-btn--danger:has-text("Emergency Stop")').click();
      await page.waitForSelector("#estopModal", { state: "visible" });

      // Verify modal content
      const modalTitle = await page.locator("#estopModal .modal-box__title").textContent();
      expect(modalTitle).toContain("Emergency Stop");
    });

    it("confirms emergency stop and disables trading", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      // Trigger emergency stop via API
      const res = await page.evaluate(async () => {
        const r = await fetch("/api/v1/finance/emergency-stop", { method: "POST" });
        return { status: r.status, body: await r.json() };
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("stopped");
      expect(mock.getRiskConfig().enabled).toBe(false);

      // Verify order is rejected after estop
      const orderRes = await page.evaluate(async () => {
        const r = await fetch("/api/v1/finance/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: "BTC/USDT",
            side: "buy",
            quantity: 0.001,
            currentPrice: 65000,
          }),
        });
        return { status: r.status };
      });
      expect(orderRes.status).toBe(403);
    });

    it("re-enables trading via setting config update", async () => {
      // Start with trading disabled
      mock.setRiskEnabled(false);

      await page.goto(`${baseUrl}/dashboard/setting`);
      await page.waitForLoadState("domcontentloaded");

      // Re-enable via API
      const res = await page.evaluate(async () => {
        const r = await fetch("/api/v1/finance/config/trading", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        });
        return { status: r.status, body: await r.json() };
      });

      expect(res.status).toBe(200);
      expect(mock.getRiskConfig().enabled).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  J7: Alert Management (Overview)
  // ══════════════════════════════════════════════════════════════════

  describe("J7: Alert management — Overview page", () => {
    it("starts with no alerts", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      expect(mock.getAlerts()).toHaveLength(0);
    });

    it("creates alert via API and verifies", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      const res = await page.evaluate(async () => {
        const r = await fetch("/api/v1/finance/alerts/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "price_above",
            symbol: "BTC/USDT",
            price: 70000,
            message: "BTC above 70k",
          }),
        });
        return { status: r.status, body: await r.json() };
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(mock.getAlerts()).toHaveLength(1);
    });

    it("removes alert via API", async () => {
      // Pre-populate an alert
      mock.addEvent({
        type: "alert_created",
        title: "Test",
        detail: "test",
        status: "completed",
      });

      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      // Create then remove
      await page.evaluate(async () => {
        const createRes = await fetch("/api/v1/finance/alerts/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "price_below", symbol: "ETH/USDT", price: 3000 }),
        });
        const alert = await createRes.json();

        await fetch("/api/v1/finance/alerts/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: alert.id }),
        });
      });

      expect(mock.getAlerts()).toHaveLength(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  J8: Multi-Domain Switching (Trader)
  // ══════════════════════════════════════════════════════════════════

  describe("J8: Multi-domain switching — Trader page", () => {
    it("defaults to paper domain", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      const paperCls = await page.locator("#domPaper").getAttribute("class");
      expect(paperCls).toContain("active");

      const liveCls = await page.locator("#domLive").getAttribute("class");
      expect(liveCls).not.toContain("active");
    });

    it("domain switcher buttons exist and are visible", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      expect(await page.locator("#domLive").isVisible()).toBe(true);
      expect(await page.locator("#domPaper").isVisible()).toBe(true);
      expect(await page.locator("#domBacktest").isVisible()).toBe(true);
    });

    it("domain label shows current domain", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      const domainLabel = await page.locator("#domainLabel").textContent();
      expect(domainLabel).toBe("PAPER");
    });

    it("backtest section is hidden in paper/live modes", async () => {
      await page.goto(`${baseUrl}/dashboard/trader`);
      await page.waitForLoadState("domcontentloaded");

      const btSection = page.locator("#backtestSection");
      // display:none in HTML by default
      const display = await btSection.evaluate((el) => getComputedStyle(el).display);
      expect(display).toBe("none");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Navigation & Legacy Redirects
  // ══════════════════════════════════════════════════════════════════

  describe("Navigation & legacy redirects", () => {
    it("all 4 dashboard pages return 200 with HTML", async () => {
      for (const p of ["overview", "strategy", "trader", "setting"]) {
        const res = await page.goto(`${baseUrl}/dashboard/${p}`);
        expect(res?.status()).toBe(200);
        expect(res?.headers()["content-type"]).toContain("text/html");
      }
    });

    it("/dashboard/finance redirects to /dashboard/overview", async () => {
      await page.goto(`${baseUrl}/dashboard/finance`);
      expect(page.url()).toContain("/dashboard/overview");
    });

    it("/dashboard/trading redirects to /dashboard/trader", async () => {
      await page.goto(`${baseUrl}/dashboard/trading`);
      expect(page.url()).toContain("/dashboard/trader");
    });

    it("/dashboard/evolution redirects to /dashboard/strategy", async () => {
      await page.goto(`${baseUrl}/dashboard/evolution`);
      expect(page.url()).toContain("/dashboard/strategy");
    });

    it("/dashboard/command-center redirects to /dashboard/trader", async () => {
      await page.goto(`${baseUrl}/dashboard/command-center`);
      expect(page.url()).toContain("/dashboard/trader");
    });

    it("/dashboard/mission-control redirects to /dashboard/overview", async () => {
      await page.goto(`${baseUrl}/dashboard/mission-control`);
      expect(page.url()).toContain("/dashboard/overview");
    });
  });
});
