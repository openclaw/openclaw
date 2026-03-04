/**
 * HTTP route handler registration for all fin-core API and dashboard endpoints.
 * Covers: config, trading, orders, positions, alerts, strategies, emergency stop,
 * events, risk evaluation, exchange health, and dashboard HTML pages.
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
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

export type RouteHandlerDeps = {
  api: OpenClawPluginApi;
  gatherDeps: DataGatheringDeps;
  eventStore: AgentEventSqliteStore;
  healthStore: ExchangeHealthStore;
  riskController: RiskController;
  runtime: RuntimeServices;
  templates: DashboardTemplates;
  registry?: ExchangeRegistry;
};

export function registerHttpRoutes(deps: RouteHandlerDeps): void {
  const { api, gatherDeps, eventStore, healthStore, riskController, runtime, templates } = deps;

  // ── Config JSON endpoint ──
  api.registerHttpRoute({
    path: "/api/v1/finance/config",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherFinanceConfigData(gatherDeps));
    },
  });

  // ── Finance Dashboard → redirect to unified overview ──
  api.registerHttpRoute({
    path: "/dashboard/finance",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/dashboard/overview" });
      res.end();
    },
  });

  // ── Exchange Health ──
  api.registerHttpRoute({
    path: "/api/v1/finance/exchange-health",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, { exchanges: healthStore.listAll() });
    },
  });

  // ── Trading JSON endpoint ──
  api.registerHttpRoute({
    path: "/api/v1/finance/trading",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherTradingData(gatherDeps));
    },
  });

  // ── Trading Dashboard → redirect to unified trader ──
  api.registerHttpRoute({
    path: "/dashboard/trading",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/dashboard/trader" });
      res.end();
    },
  });

  // ── Place Order ──
  api.registerHttpRoute({
    path: "/api/v1/finance/orders",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const {
          accountId,
          symbol,
          side,
          type,
          quantity,
          limitPrice,
          stopLoss,
          takeProfit,
          currentPrice,
          reason,
          strategyId,
          approvalId,
        } = body as Record<string, unknown>;

        if (!symbol || !side || !quantity) {
          errorResponse(res, 400, "Missing required fields: symbol, side, quantity");
          return;
        }

        const paperEngine = runtime.services?.get?.("fin-paper-engine") as
          | PaperEngineLike
          | undefined;
        if (!paperEngine) {
          errorResponse(res, 503, "Paper trading engine not available");
          return;
        }

        // Risk evaluation (skip if this is an approved action)
        const estimatedUsd = ((currentPrice as number) ?? 0) * ((quantity as number) ?? 0);
        if (!approvalId && estimatedUsd > 0) {
          const evaluation = riskController.evaluate(
            {
              symbol: symbol as string,
              side: side as string,
              amount: quantity as number,
            } as Parameters<typeof riskController.evaluate>[0],
            estimatedUsd,
          );

          if (evaluation.tier === "reject") {
            errorResponse(res, 403, evaluation.reason ?? "Order rejected by risk controller");
            return;
          }

          if (evaluation.tier === "confirm") {
            const event = eventStore.addEvent({
              type: "trade_pending",
              title: `${(side as string).toUpperCase()} ${quantity} ${symbol}`,
              detail: evaluation.reason ?? "Requires user confirmation",
              status: "pending",
              actionParams: {
                accountId,
                symbol,
                side,
                type,
                quantity,
                limitPrice,
                stopLoss,
                takeProfit,
                currentPrice,
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

        // Verify approval if provided
        if (approvalId) {
          const event = eventStore.getEvent(approvalId as string);
          if (!event || event.status !== "approved") {
            errorResponse(res, 403, "Invalid or unapproved approval ID");
            return;
          }
        }

        // Use first account if not specified
        let targetAccountId = accountId as string | undefined;
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
            side,
            type: type ?? "market",
            quantity,
            limitPrice,
            stopLoss,
            takeProfit,
            reason,
            strategyId,
          },
          (currentPrice as number) ?? 0,
        );

        eventStore.addEvent({
          type: "trade_executed",
          title: `${(side as string).toUpperCase()} ${quantity} ${symbol}`,
          detail: `Order ${(order as { status?: string }).status ?? "submitted"} via paper engine`,
          status: "completed",
        });

        jsonResponse(res, 201, order);
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Cancel Order ──
  api.registerHttpRoute({
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
    path: "/api/v1/finance/command-center",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherCommandCenterData(gatherDeps));
    },
  });

  // ── Command Center Dashboard → redirect to unified trader ──
  api.registerHttpRoute({
    path: "/dashboard/command-center",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/dashboard/trader" });
      res.end();
    },
  });

  // ── Mission Control ──
  api.registerHttpRoute({
    path: "/api/v1/finance/mission-control",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherMissionControlData(gatherDeps));
    },
  });

  // ── Mission Control Dashboard → redirect to unified overview ──
  api.registerHttpRoute({
    path: "/dashboard/mission-control",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/dashboard/overview" });
      res.end();
    },
  });

  // ── Unified Dashboard: Overview ──
  api.registerHttpRoute({
    path: "/dashboard/overview",
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
    path: "/dashboard/strategy",
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
    path: "/dashboard/trader",
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
    path: "/dashboard/setting",
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
    path: "/api/v1/finance/dashboard/strategy",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherStrategyData(gatherDeps));
    },
  });

  api.registerHttpRoute({
    path: "/api/v1/finance/dashboard/trader",
    handler: async (req: unknown, res: HttpRes) => {
      const url = (req as { url?: string }).url ?? "";
      const match = url.match(/[?&]domain=(live|paper|backtest)/);
      const domain = (match?.[1] ?? "paper") as "live" | "paper" | "backtest";
      jsonResponse(res, 200, await gatherTraderData(gatherDeps, { domain }));
    },
  });

  api.registerHttpRoute({
    path: "/api/v1/finance/dashboard/setting",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherSettingData({ ...gatherDeps, healthStore }));
    },
  });

  // ── Legacy path redirects ──
  for (const [from, to] of [
    ["/dashboard/evolution", "/dashboard/strategy-lab"],
    ["/dashboard/fund", "/dashboard/strategy-lab"],
    ["/dashboard/trading-desk", "/dashboard/trader"],
    ["/dashboard/strategy-arena", "/dashboard/strategy"],
    ["/dashboard/strategy-lab", "/dashboard/strategy"],
  ] as const) {
    api.registerHttpRoute({
      path: from,
      handler: async (_req: unknown, res: HttpRes) => {
        res.writeHead(302, { Location: to });
        res.end();
      },
    });
  }
}
