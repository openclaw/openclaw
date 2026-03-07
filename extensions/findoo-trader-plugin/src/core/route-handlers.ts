/**
 * HTTP route handler registration for all fin-core API and dashboard endpoints.
 * Covers: config, trading, orders, positions, alerts, strategies, emergency stop,
 * events, risk evaluation, exchange health, and dashboard HTML pages.
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { LiveExecutor } from "../execution/live-executor.js";
import type { PerformanceSnapshotStore } from "../fund/performance-snapshot-store.js";
import { submitOrderSchema } from "../schemas.js";
import type {
  HttpReq,
  HttpRes,
  PaperEngineLike,
  RuntimeServices,
  StrategyRegistryLike,
} from "../types-http.js";
import { parseJsonBody, jsonResponse, errorResponse } from "../types-http.js";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import type { DataGatheringDeps } from "./data-gathering.js";
import {
  gatherFinanceConfigData,
  gatherTradingData,
  gatherCommandCenterData,
  gatherMissionControlData,
  gatherOverviewData,
  gatherSettingData,
  gatherTraderData,
  gatherStrategyData,
  gatherFlowData,
} from "./data-gathering.js";
import type { ExchangeHealthStore } from "./exchange-health-store.js";
import type { ExchangeRegistry } from "./exchange-registry.js";
import type { RiskController } from "./risk-controller.js";
import { registerAiChatRoute } from "./routes-ai-chat.js";
import { registerAlertRoutes } from "./routes-alerts.js";
import { registerSettingRoutes } from "./routes-setting.js";
import { registerStrategyRoutes } from "./routes-strategies.js";
import type { DashboardTemplates } from "./template-renderer.js";
import { renderDashboard, renderUnifiedDashboard } from "./template-renderer.js";

type IdeationSchedulerLike = {
  getStats(): {
    running: boolean;
    cycleCount: number;
    lastCycleAt: number | null;
    enabled: boolean;
    intervalMs: number;
  };
  getLastResult(): unknown;
  runCycle(): Promise<unknown>;
};

type LifecycleEngineLike = {
  getStats(): {
    running: boolean;
    cycleCount: number;
    lastCycleAt: number;
    promotionCount: number;
    demotionCount: number;
    pendingApprovals: number;
  };
  handleApproval(strategyId: string): boolean;
  handleRejection(strategyId: string, reason?: string): boolean;
};

export type RouteHandlerDeps = {
  api: OpenClawPluginApi;
  gatherDeps: DataGatheringDeps;
  eventStore: AgentEventSqliteStore;
  healthStore: ExchangeHealthStore;
  riskController: RiskController;
  runtime: RuntimeServices;
  templates: DashboardTemplates;
  registry?: ExchangeRegistry;
  perfStore?: PerformanceSnapshotStore;
  lifecycleEngine?: LifecycleEngineLike;
  ideationScheduler?: IdeationSchedulerLike;
};

export function registerHttpRoutes(deps: RouteHandlerDeps): void {
  const { api, gatherDeps, eventStore, healthStore, riskController, runtime, templates } = deps;

  // ── Config JSON endpoint ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/config",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherFinanceConfigData(gatherDeps));
    },
  });

  // ── Finance Dashboard → redirect to unified overview ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/findoo-trader/dashboard/finance",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/plugins/findoo-trader/dashboard/overview" });
      res.end();
    },
  });

  // ── Exchange Health ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/exchange-health",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, { exchanges: healthStore.listAll() });
    },
  });

  // ── Trading JSON endpoint ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/trading",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherTradingData(gatherDeps));
    },
  });

  // ── Trading Dashboard → redirect to unified trader ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/findoo-trader/dashboard/trading",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/plugins/findoo-trader/dashboard/trader" });
      res.end();
    },
  });

  // ── Place Order (unified: paper + live) ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/orders",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const parsed = submitOrderSchema.safeParse(body);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
          errorResponse(res, 400, `Validation failed: ${issues.join("; ")}`);
          return;
        }

        const {
          symbol,
          side,
          type: orderType,
          price,
          amount,
          domain,
          accountId,
          exchangeId,
          stopLoss,
          takeProfit,
          approvalId,
          reason,
          strategyId,
        } = parsed.data;

        // ── Risk evaluation (skip if pre-approved) ──
        const estimatedUsd = (price ?? 0) * amount;
        if (!approvalId && estimatedUsd > 0) {
          const evaluation = riskController.evaluate(
            { symbol, side, amount } as Parameters<typeof riskController.evaluate>[0],
            estimatedUsd,
          );

          if (evaluation.tier === "reject") {
            errorResponse(res, 403, evaluation.reason ?? "Order rejected by risk controller");
            return;
          }

          if (evaluation.tier === "confirm") {
            const event = eventStore.addEvent({
              type: "trade_pending",
              title: `${side.toUpperCase()} ${amount} ${symbol}`,
              detail: evaluation.reason ?? "Requires user confirmation",
              status: "pending",
              actionParams: {
                symbol,
                side,
                type: orderType,
                price,
                amount,
                domain,
                accountId,
                exchangeId,
                stopLoss,
                takeProfit,
                reason,
                strategyId,
              },
            });
            jsonResponse(res, 202, {
              status: "pending_approval",
              eventId: event.id,
              reason: evaluation.reason,
            });
            return;
          }
        }

        // ── Verify approval if provided ──
        if (approvalId) {
          const event = eventStore.getEvent(approvalId);
          if (!event || event.status !== "approved") {
            errorResponse(res, 403, "Invalid or unapproved approval ID");
            return;
          }
        }

        // ── Route to executor based on domain ──
        if (domain === "live") {
          const liveExecutor = runtime.services?.get?.("fin-live-executor") as
            | LiveExecutor
            | undefined;
          if (!liveExecutor) {
            errorResponse(res, 503, "Live trading executor not available");
            return;
          }

          const order = await liveExecutor.placeOrder({
            exchangeId,
            symbol,
            side,
            type: orderType === "stop-limit" ? "limit" : orderType,
            amount,
            price,
            params: stopLoss || takeProfit ? { stopLoss, takeProfit } : undefined,
          });

          eventStore.addEvent({
            type: "trade_executed",
            title: `[LIVE] ${side.toUpperCase()} ${amount} ${symbol}`,
            detail: `Order ${(order as { status?: string }).status ?? "submitted"} via live executor`,
            status: "completed",
          });

          jsonResponse(res, 201, { domain, order });
          return;
        }

        // ── Paper domain (default) ──
        const paperEngine = runtime.services?.get?.("fin-paper-engine") as
          | PaperEngineLike
          | undefined;
        if (!paperEngine) {
          errorResponse(res, 503, "Paper trading engine not available");
          return;
        }

        let targetAccountId = accountId;
        if (!targetAccountId) {
          const accounts = paperEngine.listAccounts();
          if (accounts.length === 0) {
            errorResponse(res, 400, "No paper trading accounts found");
            return;
          }
          targetAccountId = accounts[0]!.id;
        }

        const submitOrder = (
          paperEngine as unknown as {
            submitOrder: (
              acctId: string,
              order: Record<string, unknown>,
              currentPrice: number,
            ) => Record<string, unknown>;
          }
        ).submitOrder;

        if (!submitOrder) {
          errorResponse(res, 503, "Paper engine does not support submitOrder");
          return;
        }

        const order = submitOrder.call(
          paperEngine,
          targetAccountId,
          {
            symbol,
            side,
            type: orderType === "stop-limit" ? "limit" : orderType,
            quantity: amount,
            limitPrice: price,
            stopLoss,
            takeProfit,
            reason,
            strategyId,
          },
          price ?? 0,
        );

        eventStore.addEvent({
          type: "trade_executed",
          title: `${side.toUpperCase()} ${amount} ${symbol}`,
          detail: `Order ${(order as { status?: string }).status ?? "submitted"} via paper engine`,
          status: "completed",
        });

        jsonResponse(res, 201, { domain, order });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Cancel Order ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/orders/cancel",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { orderId, accountId } = body as { orderId?: string; accountId?: string };

        if (!orderId) {
          errorResponse(res, 400, "Missing required field: orderId");
          return;
        }

        eventStore.addEvent({
          type: "order_cancelled",
          title: `Cancel order ${orderId}`,
          detail: `Order cancellation requested${accountId ? ` for account ${accountId}` : ""}`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "cancelled", orderId });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Close Position ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/positions/close",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { symbol, accountId } = body as { symbol?: string; accountId?: string };

        if (!symbol) {
          errorResponse(res, 400, "Missing required field: symbol");
          return;
        }

        const paperEngine = runtime.services?.get?.("fin-paper-engine") as
          | PaperEngineLike
          | undefined;
        if (!paperEngine) {
          errorResponse(res, 503, "Paper trading engine not available");
          return;
        }

        let targetAccountId = accountId;
        if (!targetAccountId) {
          const accounts = paperEngine.listAccounts();
          targetAccountId = accounts[0]?.id;
        }
        if (!targetAccountId) {
          errorResponse(res, 400, "No paper trading accounts found");
          return;
        }

        const state = paperEngine.getAccountState(targetAccountId);
        if (!state) {
          errorResponse(res, 404, `Account ${targetAccountId} not found`);
          return;
        }

        const position = state.positions.find((p) => p.symbol === symbol);
        if (!position) {
          errorResponse(res, 404, `No open position for ${symbol}`);
          return;
        }

        const closeSide = position.side === "long" ? "sell" : "buy";
        const submitOrder = (
          paperEngine as unknown as {
            submitOrder: (
              accountId: string,
              order: Record<string, unknown>,
              currentPrice: number,
            ) => Record<string, unknown>;
          }
        ).submitOrder;

        if (!submitOrder) {
          errorResponse(res, 503, "Paper engine does not support submitOrder");
          return;
        }

        const order = submitOrder.call(
          paperEngine,
          targetAccountId,
          {
            symbol,
            side: closeSide,
            type: "market",
            quantity: position.quantity,
            reason: "Position closed via UI",
          },
          position.currentPrice,
        );

        eventStore.addEvent({
          type: "trade_executed",
          title: `Close ${symbol} ${position.side}`,
          detail: `Closed ${position.quantity} ${symbol} at ${position.currentPrice}`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "closed", order });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Alert CRUD ──
  registerAlertRoutes(api, runtime, eventStore);

  // ── Strategy Management ──
  registerStrategyRoutes(api, runtime, eventStore);

  // ── Setting CRUD ──
  if (deps.registry) {
    registerSettingRoutes({
      api,
      registry: deps.registry,
      healthStore,
      riskController,
      eventStore,
      runtime,
    });
  }

  // ── AI Chat ──
  registerAiChatRoute(api, runtime);

  // ── Emergency Stop ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/emergency-stop",
    handler: async (_req: unknown, res: HttpRes) => {
      try {
        riskController.updateConfig({ enabled: false });

        const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
          | StrategyRegistryLike
          | undefined;
        const pausedStrategies: string[] = [];
        if (strategyRegistry?.list && strategyRegistry.updateStatus) {
          for (const s of strategyRegistry.list()) {
            if (s.level !== "KILLED" && s.status !== "stopped" && s.status !== "paused") {
              strategyRegistry.updateStatus(s.id, "paused");
              pausedStrategies.push(s.id);
            }
          }
        }

        eventStore.addEvent({
          type: "emergency_stop",
          title: "EMERGENCY STOP ACTIVATED",
          detail: `Trading disabled. ${pausedStrategies.length} strategies paused.`,
          status: "completed",
        });

        jsonResponse(res, 200, {
          status: "stopped",
          tradingDisabled: true,
          strategiesPaused: pausedStrategies,
          message: "Emergency stop activated. All trading disabled.",
        });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Events List ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/events",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, {
        events: eventStore.listEvents(),
        pendingCount: eventStore.pendingCount(),
      });
    },
  });

  // ── Approval Flow ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/events/approve",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { id, action } = body as {
          id?: string;
          action?: "approve" | "reject";
          reason?: string;
        };

        if (!id) {
          errorResponse(res, 400, "Missing required field: id");
          return;
        }

        if (action === "reject") {
          const event = eventStore.reject(id, (body as { reason?: string }).reason);
          if (!event) {
            errorResponse(res, 404, `Event ${id} not found or not pending`);
            return;
          }
          jsonResponse(res, 200, { status: "rejected", event });
          return;
        }

        const event = eventStore.approve(id);
        if (!event) {
          errorResponse(res, 404, `Event ${id} not found or not pending`);
          return;
        }

        // Post-approval action: execute promote_l3
        if (event?.actionParams?.action === "promote_l3") {
          const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
            | StrategyRegistryLike
            | undefined;
          if (strategyRegistry?.updateLevel && event.actionParams.strategyId) {
            strategyRegistry.updateLevel(event.actionParams.strategyId as string, "L3_LIVE");
          }
        }

        jsonResponse(res, 200, { status: "approved", event });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Risk Evaluation ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/risk/evaluate",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { symbol, side, amount, estimatedValueUsd } = body as Record<string, unknown>;

        if (!symbol || !amount) {
          errorResponse(res, 400, "Missing required fields: symbol, amount");
          return;
        }

        const evaluation = riskController.evaluate(
          { symbol, side: side ?? "buy", amount } as Parameters<typeof riskController.evaluate>[0],
          (estimatedValueUsd as number) ?? 0,
        );

        jsonResponse(res, 200, evaluation);
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Command Center ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/command-center",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherCommandCenterData(gatherDeps));
    },
  });

  // ── Command Center Dashboard → redirect to unified trader ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/findoo-trader/dashboard/command-center",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/plugins/findoo-trader/dashboard/trader" });
      res.end();
    },
  });

  // ── Mission Control ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/mission-control",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherMissionControlData(gatherDeps));
    },
  });

  // ── Mission Control Dashboard → redirect to unified overview ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/findoo-trader/dashboard/mission-control",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/plugins/findoo-trader/dashboard/overview" });
      res.end();
    },
  });

  // ── Unified Dashboard: Overview ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/findoo-trader/dashboard/overview",
    handler: async (_req: unknown, res: HttpRes) => {
      const data = gatherOverviewData(gatherDeps);
      const html = renderUnifiedDashboard(templates.overview, data);
      if (!html) {
        jsonResponse(res, 200, data);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });

  // ── Unified Dashboard: Strategy (merged Arena + Lab) ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/findoo-trader/dashboard/strategy",
    handler: async (_req: unknown, res: HttpRes) => {
      const data = gatherStrategyData(gatherDeps);
      const html = renderUnifiedDashboard(templates.strategy, data);
      if (!html) {
        jsonResponse(res, 200, data);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });

  // ── Unified Dashboard: Trader (with domain switching) ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/findoo-trader/dashboard/trader",
    handler: async (req: unknown, res: HttpRes) => {
      // Extract domain from query string if available
      const url = (req as { url?: string }).url ?? "";
      const match = url.match(/[?&]domain=(live|paper|backtest)/);
      const domain = (match?.[1] ?? "paper") as "live" | "paper" | "backtest";
      const data = await gatherTraderData(gatherDeps, { domain });
      const html = renderUnifiedDashboard(templates.trader, data);
      if (!html) {
        jsonResponse(res, 200, data);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });

  // ── Unified Dashboard: Setting ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/findoo-trader/dashboard/setting",
    handler: async (_req: unknown, res: HttpRes) => {
      const data = gatherSettingData({ ...gatherDeps, healthStore });
      const html = renderUnifiedDashboard(templates.setting, data);
      if (!html) {
        jsonResponse(res, 200, data);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });

  // ── JSON API for new dashboard tabs ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/dashboard/strategy",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherStrategyData(gatherDeps));
    },
  });

  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/dashboard/trader",
    handler: async (req: unknown, res: HttpRes) => {
      const url = (req as { url?: string }).url ?? "";
      const match = url.match(/[?&]domain=(live|paper|backtest)/);
      const domain = (match?.[1] ?? "paper") as "live" | "paper" | "backtest";
      jsonResponse(res, 200, await gatherTraderData(gatherDeps, { domain }));
    },
  });

  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/dashboard/setting",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherSettingData({ ...gatherDeps, healthStore }));
    },
  });

  // ── Unified Dashboard: Flow (lifecycle pipeline) ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/findoo-trader/dashboard/flow",
    handler: async (_req: unknown, res: HttpRes) => {
      const data = gatherFlowData(gatherDeps, deps.lifecycleEngine);
      const html = renderUnifiedDashboard(templates.flow, data);
      if (!html) {
        jsonResponse(res, 200, data);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });

  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/dashboard/flow",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherFlowData(gatherDeps, deps.lifecycleEngine));
    },
  });

  // ── Flow: Approve L3 promotion ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/flow/approve",
    handler: async (req: unknown, res: HttpRes) => {
      const body = await parseJsonBody(req as HttpReq);
      const strategyId = body?.strategyId as string | undefined;
      if (!strategyId) {
        errorResponse(res, 400, "Missing strategyId");
        return;
      }
      const engine = deps.lifecycleEngine;
      if (!engine) {
        errorResponse(res, 503, "Lifecycle engine not available");
        return;
      }
      const ok = engine.handleApproval(strategyId);
      jsonResponse(res, ok ? 200 : 404, { ok, strategyId });
    },
  });

  // ── Flow: Reject L3 promotion ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/flow/reject",
    handler: async (req: unknown, res: HttpRes) => {
      const body = await parseJsonBody(req as HttpReq);
      const strategyId = body?.strategyId as string | undefined;
      const reason = body?.reason as string | undefined;
      if (!strategyId) {
        errorResponse(res, 400, "Missing strategyId");
        return;
      }
      const engine = deps.lifecycleEngine;
      if (!engine) {
        errorResponse(res, 503, "Lifecycle engine not available");
        return;
      }
      const ok = engine.handleRejection(strategyId, reason);
      jsonResponse(res, ok ? 200 : 404, { ok, strategyId });
    },
  });

  // ── OHLCV K-line Data ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/ohlcv",
    handler: async (req: unknown, res: HttpRes) => {
      try {
        const url = (req as { url?: string }).url ?? "";
        const qs = new URLSearchParams(url.split("?")[1] ?? "");
        const symbol = qs.get("symbol");
        if (!symbol) {
          errorResponse(res, 400, "Missing required query parameter: symbol");
          return;
        }

        const market = qs.get("market") ?? "crypto";
        const timeframe = qs.get("timeframe") ?? "1h";
        const limit = parseInt(qs.get("limit") ?? "300", 10);

        const dataProvider = runtime.services?.get?.("fin-data-provider") as
          | {
              getOHLCV: (params: {
                symbol: string;
                market: string;
                timeframe: string;
                limit?: number;
              }) => Promise<unknown[]>;
            }
          | undefined;
        if (!dataProvider) {
          errorResponse(res, 503, "Data provider service not available");
          return;
        }

        const candles = await dataProvider.getOHLCV({ symbol, market, timeframe, limit });
        jsonResponse(res, 200, { symbol, market, timeframe, candles });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── OrderBook Data ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/orderbook",
    handler: async (req: unknown, res: HttpRes) => {
      try {
        const url = (req as { url?: string }).url ?? "";
        const qs = new URLSearchParams(url.split("?")[1] ?? "");
        const symbol = qs.get("symbol");
        if (!symbol) {
          errorResponse(res, 400, "Missing required query parameter: symbol");
          return;
        }
        const exchangeId = qs.get("exchangeId") ?? undefined;
        const limit = parseInt(qs.get("limit") ?? "20", 10);

        const registry = deps.registry;
        if (!registry) {
          errorResponse(res, 404, "No exchanges configured");
          return;
        }

        type OrderBookExchange = {
          fetchOrderBook: (
            symbol: string,
            limit: number,
          ) => Promise<{ bids: [number, number][]; asks: [number, number][]; timestamp?: number }>;
        };
        let exchange: OrderBookExchange | undefined;
        let resolvedExchangeId = exchangeId;

        if (exchangeId) {
          try {
            exchange = (await registry.getInstance(exchangeId)) as OrderBookExchange;
          } catch {
            errorResponse(res, 404, `Exchange "${exchangeId}" not found`);
            return;
          }
        } else {
          const exchanges = registry.listExchanges();
          if (!exchanges || exchanges.length === 0) {
            errorResponse(res, 404, "No exchanges configured");
            return;
          }
          resolvedExchangeId = exchanges[0]!.id;
          exchange = (await registry.getInstance(resolvedExchangeId)) as OrderBookExchange;
        }

        if (!exchange?.fetchOrderBook) {
          errorResponse(res, 500, "Exchange does not support fetchOrderBook");
          return;
        }

        const book = await exchange.fetchOrderBook(symbol, limit);
        jsonResponse(res, 200, {
          symbol,
          exchangeId: resolvedExchangeId ?? "default",
          bids: book.bids,
          asks: book.asks,
          timestamp: book.timestamp ?? Date.now(),
        });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Performance Snapshots ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/performance",
    handler: async (req: unknown, res: HttpRes) => {
      try {
        const { perfStore } = deps;
        if (!perfStore) {
          errorResponse(res, 503, "Performance snapshot store not available");
          return;
        }

        const url = (req as { url?: string }).url ?? "";
        const ptMatch = url.match(/[?&]periodType=([^&]+)/);
        const limitMatch = url.match(/[?&]limit=(\d+)/);
        const periodType = ptMatch ? decodeURIComponent(ptMatch[1]!) : "daily";
        const limit = limitMatch ? parseInt(limitMatch[1]!, 10) : 30;

        const snapshots = perfStore.getLatest(periodType, limit);
        jsonResponse(res, 200, { snapshots });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Ideation: Status ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/ideation/status",
    handler: async (_req: unknown, res: HttpRes) => {
      const scheduler = deps.ideationScheduler;
      if (!scheduler) {
        jsonResponse(res, 200, { enabled: false, message: "Ideation scheduler not initialized" });
        return;
      }
      jsonResponse(res, 200, {
        stats: scheduler.getStats(),
        lastResult: scheduler.getLastResult(),
      });
    },
  });

  // ── Ideation: Manual Trigger ──
  api.registerHttpRoute({
    auth: "plugin",

    path: "/api/v1/finance/ideation/trigger",
    handler: async (_req: unknown, res: HttpRes) => {
      const scheduler = deps.ideationScheduler;
      if (!scheduler) {
        errorResponse(res, 503, "Ideation scheduler not initialized");
        return;
      }
      try {
        const result = await scheduler.runCycle();
        jsonResponse(res, 200, { triggered: true, result });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Legacy path redirects (old namespaced paths) ──
  for (const [from, to] of [
    ["/plugins/findoo-trader/dashboard/evolution", "/plugins/findoo-trader/dashboard/strategy"],
    ["/plugins/findoo-trader/dashboard/trading-desk", "/plugins/findoo-trader/dashboard/trader"],
    [
      "/plugins/findoo-trader/dashboard/strategy-arena",
      "/plugins/findoo-trader/dashboard/strategy",
    ],
    ["/plugins/findoo-trader/dashboard/strategy-lab", "/plugins/findoo-trader/dashboard/strategy"],
  ] as const) {
    api.registerHttpRoute({
      auth: "plugin",
      path: from,
      handler: async (_req: unknown, res: HttpRes) => {
        res.writeHead(302, { Location: to });
        res.end();
      },
    });
  }

  // ── Backward-compat: /dashboard/* → /plugins/findoo-trader/dashboard/* ──
  for (const page of [
    "overview",
    "strategy",
    "trader",
    "setting",
    "flow",
    "finance",
    "trading",
    "command-center",
    "mission-control",
    "evolution",
    "trading-desk",
    "strategy-arena",
    "strategy-lab",
  ]) {
    api.registerHttpRoute({
      auth: "plugin",
      path: `/dashboard/${page}`,
      handler: async (req: unknown, res: HttpRes) => {
        const url = (req as { url?: string }).url ?? "";
        const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
        res.writeHead(301, {
          Location: `/plugins/findoo-trader/dashboard/${page}${qs}`,
        });
        res.end();
      },
    });
  }
}
