/**
 * HTTP route handler registration for all fin-core API and dashboard endpoints.
 * Covers: config, trading, orders, positions, alerts, strategies, emergency stop,
 * events, risk evaluation, exchange health, and dashboard HTML pages.
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import type { DataGatheringDeps } from "./data-gathering.js";
import {
  gatherFinanceConfigData,
  gatherTradingData,
  gatherCommandCenterData,
  gatherMissionControlData,
  gatherOverviewData,
  gatherStrategyLabData,
  gatherStrategyArenaData,
} from "./data-gathering.js";
import type { ExchangeHealthStore } from "./exchange-health-store.js";
import type { RiskController } from "./risk-controller.js";
import { registerAiChatRoute } from "./routes-ai-chat.js";
import { registerAlertRoutes } from "./routes-alerts.js";
import { registerStrategyRoutes } from "./routes-strategies.js";
import type { DashboardTemplates } from "./template-renderer.js";
import { renderDashboard, renderUnifiedDashboard } from "./template-renderer.js";
import type {
  HttpReq,
  HttpRes,
  PaperEngineLike,
  RuntimeServices,
  StrategyRegistryLike,
} from "./types-http.js";
import { parseJsonBody, jsonResponse, errorResponse } from "./types-http.js";

export type RouteHandlerDeps = {
  api: OpenClawPluginApi;
  gatherDeps: DataGatheringDeps;
  eventStore: AgentEventSqliteStore;
  healthStore: ExchangeHealthStore;
  riskController: RiskController;
  runtime: RuntimeServices;
  templates: DashboardTemplates;
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

  // ── Test Exchange Connection ──
  // Validates exchange credentials by attempting to fetch balance via CCXT.
  api.registerHttpRoute({
    path: "/api/v1/finance/exchanges/test",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { exchange, apiKey, secret, passphrase, testnet } = body as {
          exchange?: string;
          apiKey?: string;
          secret?: string;
          passphrase?: string;
          testnet?: boolean;
        };

        if (!exchange || !apiKey || !secret) {
          errorResponse(res, 400, "Missing required fields: exchange, apiKey, secret");
          return;
        }

        const supportedExchanges = ["binance", "okx", "bybit", "hyperliquid"];
        if (!supportedExchanges.includes(exchange)) {
          errorResponse(res, 400, `Unsupported exchange: ${exchange}. Supported: ${supportedExchanges.join(", ")}`);
          return;
        }

        // Dynamically import ccxt to avoid startup cost
        const ccxt = await import("ccxt");
        const ExchangeClass = (ccxt as Record<string, unknown>)[exchange];
        if (typeof ExchangeClass !== "function") {
          errorResponse(res, 400, `Exchange class not found: ${exchange}`);
          return;
        }

        const instance = new (ExchangeClass as new (opts: Record<string, unknown>) => Record<string, unknown>)({
          apiKey,
          secret,
          password: passphrase,
          enableRateLimit: true,
          timeout: 15000,
        });

        // Enable sandbox/testnet mode if requested
        if (testnet && typeof instance.setSandboxMode === "function") {
          (instance as { setSandboxMode: (v: boolean) => void }).setSandboxMode(true);
        }

        try {
          const balance = await (instance as { fetchBalance: () => Promise<Record<string, unknown>> }).fetchBalance();

          // Extract non-zero balances for display (hide full API key from response)
          const total = (balance.total ?? {}) as Record<string, number>;
          const nonZero: Record<string, number> = {};
          for (const [currency, amount] of Object.entries(total)) {
            if (typeof amount === "number" && amount > 0) {
              nonZero[currency] = Math.round(amount * 1e6) / 1e6;
            }
          }

          jsonResponse(res, 200, { ok: true, balances: nonZero });
        } catch (err) {
          const message = (err as Error).message || "Unknown error";
          // Classify error type without leaking sensitive details
          const isAuth =
            message.includes("AuthenticationError") ||
            message.includes("Invalid") ||
            message.includes("Signature") ||
            message.includes("key") ||
            message.includes("permission");
          jsonResponse(res, 200, {
            ok: false,
            error: isAuth ? "Authentication failed: check API key and secret" : "Connection failed: " + message,
          });
        } finally {
          // Best-effort cleanup
          try {
            if (typeof instance.close === "function") {
              await (instance as { close: () => Promise<void> }).close();
            }
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── Trading JSON endpoint ──
  api.registerHttpRoute({
    path: "/api/v1/finance/trading",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherTradingData(gatherDeps));
    },
  });

  // ── Trading Dashboard → redirect to unified trading desk ──
  api.registerHttpRoute({
    path: "/dashboard/trading",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/dashboard/trading-desk" });
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

  // ── Command Center Dashboard → redirect to unified trading desk ──
  api.registerHttpRoute({
    path: "/dashboard/command-center",
    handler: async (_req: unknown, res: HttpRes) => {
      res.writeHead(302, { Location: "/dashboard/trading-desk" });
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

  // ── Unified Dashboard: Trading Desk ──
  api.registerHttpRoute({
    path: "/dashboard/trading-desk",
    handler: async (_req: unknown, res: HttpRes) => {
      const data = gatherCommandCenterData(gatherDeps);
      const html = renderUnifiedDashboard(templates.tradingDesk, data);
      if (!html) {
        jsonResponse(res, 200, data);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });

  // ── Unified Dashboard: Strategy Arena ──
  api.registerHttpRoute({
    path: "/dashboard/strategy-arena",
    handler: async (_req: unknown, res: HttpRes) => {
      const data = gatherStrategyArenaData(gatherDeps);
      const html = renderUnifiedDashboard(templates.strategyArena, data);
      if (!html) {
        jsonResponse(res, 200, data);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });

  // ── Strategy Arena JSON endpoint ──
  api.registerHttpRoute({
    path: "/api/v1/finance/strategy-arena",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, gatherStrategyArenaData(gatherDeps));
    },
  });

  // ── Unified Dashboard: Strategy Lab ──
  api.registerHttpRoute({
    path: "/dashboard/strategy-lab",
    handler: async (_req: unknown, res: HttpRes) => {
      const data = gatherStrategyLabData(gatherDeps);
      const html = renderUnifiedDashboard(templates.strategyLab, data);
      if (!html) {
        jsonResponse(res, 200, data);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });

  // ── Legacy path redirects ──
  for (const [from, to] of [
    ["/dashboard/evolution", "/dashboard/strategy-arena"],
    ["/dashboard/fund", "/dashboard/strategy-lab"],
    ["/dashboard/strategy", "/dashboard/strategy-arena"],
    ["/dashboard/arena", "/dashboard/strategy-arena"],
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
