/**
 * Setting Tab CRUD HTTP route handlers.
 * Covers: exchange management, risk config, agent behavior config, promotion gates.
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import {
  addExchangeSchema,
  riskConfigSchema,
  agentBehaviorSchema,
  promotionGateSchema,
} from "../schemas.js";
import type { HttpReq, HttpRes, RuntimeServices } from "../types-http.js";
import { parseJsonBody, jsonResponse, errorResponse } from "../types-http.js";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import type { ExchangeHealthStore } from "./exchange-health-store.js";
import type { ExchangeRegistry } from "./exchange-registry.js";
import type { RiskController } from "./risk-controller.js";

export type SettingRouteDeps = {
  api: OpenClawPluginApi;
  registry: ExchangeRegistry;
  healthStore: ExchangeHealthStore;
  riskController: RiskController;
  eventStore: AgentEventSqliteStore;
  runtime: RuntimeServices;
};

export function registerSettingRoutes(deps: SettingRouteDeps): void {
  const { api, registry, healthStore, riskController, eventStore, runtime } = deps;

  // ── POST /api/v1/finance/exchanges — Add exchange ──
  api.registerHttpRoute({
    path: "/api/v1/finance/exchanges",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const parsed = addExchangeSchema.safeParse(body);
        if (!parsed.success) {
          errorResponse(res, 400, parsed.error.issues.map((i) => i.message).join("; "));
          return;
        }

        const { exchange, apiKey, secret, passphrase, testnet, label } = parsed.data;
        const id = label ?? `${exchange}-${Date.now().toString(36)}`;

        registry.addExchange(id, {
          exchange,
          apiKey,
          secret,
          passphrase,
          testnet,
        });

        // Initialize health record
        healthStore.upsert({
          exchangeId: id,
          exchangeName: exchange,
          connected: false,
          lastPingMs: 0,
          apiCallsToday: 0,
          apiLimit: 1200,
          lastCheckAt: null,
          errorMessage: null,
          consecutiveFailures: 0,
        });

        eventStore.addEvent({
          type: "system",
          title: `Exchange added: ${id}`,
          detail: `${exchange}${testnet ? " (testnet)" : ""} added`,
          status: "completed",
        });

        jsonResponse(res, 201, { id, exchange, testnet: testnet ?? false });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── POST /api/v1/finance/exchanges/:id/test — Test exchange connection ──
  api.registerHttpRoute({
    path: "/api/v1/finance/exchanges/test",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { id } = body as { id?: string };

        if (!id) {
          errorResponse(res, 400, "Missing required field: id");
          return;
        }

        const exchanges = registry.listExchanges();
        const found = exchanges.find((e) => e.id === id);
        if (!found) {
          errorResponse(res, 404, `Exchange "${id}" not found`);
          return;
        }

        const start = Date.now();
        try {
          const instance = await registry.getInstance(id);
          const latencyMs = Date.now() - start;

          // Try fetching markets/balance to validate connectivity
          let markets: string[] = [];
          let balance: Array<{ currency: string; free: number; total: number }> = [];

          if (typeof (instance as Record<string, unknown>).loadMarkets === "function") {
            try {
              const mkts = await (
                instance as { loadMarkets: () => Promise<Record<string, unknown>> }
              ).loadMarkets();
              markets = Object.keys(mkts).slice(0, 20);
            } catch {
              // Non-fatal — markets unavailable
            }
          }

          if (typeof (instance as Record<string, unknown>).fetchBalance === "function") {
            try {
              const bal = await (
                instance as { fetchBalance: () => Promise<Record<string, unknown>> }
              ).fetchBalance();
              const free = (bal.free ?? {}) as Record<string, number>;
              const total = (bal.total ?? {}) as Record<string, number>;
              balance = Object.keys(free)
                .filter((k) => (total[k] ?? 0) > 0)
                .slice(0, 10)
                .map((k) => ({ currency: k, free: free[k] ?? 0, total: total[k] ?? 0 }));
            } catch {
              // Non-fatal — balance unavailable
            }
          }

          healthStore.recordPing(id, latencyMs);

          jsonResponse(res, 200, {
            success: true,
            latencyMs,
            balance,
            markets,
          });
        } catch (err) {
          const latencyMs = Date.now() - start;
          const errorMsg = (err as Error).message;
          healthStore.recordError(id, errorMsg);

          jsonResponse(res, 200, {
            success: false,
            latencyMs,
            error: errorMsg,
          });
        }
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── DELETE /api/v1/finance/exchanges/:id — Remove exchange ──
  // (Using POST with body since some routers don't support DELETE well)
  api.registerHttpRoute({
    path: "/api/v1/finance/exchanges/remove",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { id } = body as { id?: string };

        if (!id) {
          errorResponse(res, 400, "Missing required field: id");
          return;
        }

        const removed = registry.removeExchange(id);
        if (!removed) {
          errorResponse(res, 404, `Exchange "${id}" not found`);
          return;
        }

        eventStore.addEvent({
          type: "system",
          title: `Exchange removed: ${id}`,
          detail: `Exchange "${id}" removed`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "removed", id });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── PUT /api/v1/finance/config/trading — Update risk/trading config ──
  api.registerHttpRoute({
    path: "/api/v1/finance/config/trading",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const parsed = riskConfigSchema.safeParse(body);
        if (!parsed.success) {
          errorResponse(res, 400, parsed.error.issues.map((i) => i.message).join("; "));
          return;
        }

        riskController.updateConfig(parsed.data);

        eventStore.addEvent({
          type: "system",
          title: "Trading config updated",
          detail: `Risk limits: auto=$${parsed.data.maxAutoTradeUsd}, confirm=$${parsed.data.confirmThresholdUsd}, dailyLoss=$${parsed.data.maxDailyLossUsd}`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "updated", config: parsed.data });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── PUT /api/v1/finance/config/agent — Update agent behavior config ──
  api.registerHttpRoute({
    path: "/api/v1/finance/config/agent",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const parsed = agentBehaviorSchema.safeParse(body);
        if (!parsed.success) {
          errorResponse(res, 400, parsed.error.issues.map((i) => i.message).join("; "));
          return;
        }

        // Store agent config in runtime services for other modules to consume
        const configStore = runtime.services?.get?.("fin-agent-config") as
          | { update: (cfg: Record<string, unknown>) => void }
          | undefined;
        if (configStore?.update) {
          configStore.update(parsed.data);
        }

        eventStore.addEvent({
          type: "system",
          title: "Agent config updated",
          detail: `Heartbeat=${parsed.data.heartbeatIntervalMs}ms, evolution=${parsed.data.evolutionEnabled}, maxStrategies=${parsed.data.maxConcurrentStrategies}`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "updated", config: parsed.data });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── PUT /api/v1/finance/config/gates — Update promotion gate thresholds ──
  api.registerHttpRoute({
    path: "/api/v1/finance/config/gates",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const parsed = promotionGateSchema.safeParse(body);
        if (!parsed.success) {
          errorResponse(res, 400, parsed.error.issues.map((i) => i.message).join("; "));
          return;
        }

        // Store gate config in runtime services for strategy engine to consume
        const configStore = runtime.services?.get?.("fin-gate-config") as
          | { update: (cfg: Record<string, unknown>) => void }
          | undefined;
        if (configStore?.update) {
          configStore.update(parsed.data);
        }

        eventStore.addEvent({
          type: "system",
          title: "Promotion gates updated",
          detail: `L0→L1: ${parsed.data.l0l1.minDays}d/${parsed.data.l0l1.minSharpe}S, L1→L2: ${parsed.data.l1l2.minDays}d/${parsed.data.l1l2.minSharpe}S, L2→L3: ${parsed.data.l2l3.minDays}d/${parsed.data.l2l3.minSharpe}S`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "updated", gates: parsed.data });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── PUT /api/v1/finance/config/notifications — Update notification config (Telegram) ──
  api.registerHttpRoute({
    path: "/api/v1/finance/config/notifications",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const telegramBotToken =
          typeof body.telegramBotToken === "string" ? body.telegramBotToken.trim() : undefined;
        const telegramChatId =
          typeof body.telegramChatId === "string" ? body.telegramChatId.trim() : undefined;

        // Persist via the plugin config store if available
        const pluginConfig = (api as unknown as { pluginConfig?: Record<string, unknown> })
          .pluginConfig;
        if (pluginConfig) {
          const notif = (pluginConfig.notifications ?? {}) as Record<string, unknown>;
          if (telegramBotToken !== undefined) notif.telegramBotToken = telegramBotToken;
          if (telegramChatId !== undefined) notif.telegramChatId = telegramChatId;
          pluginConfig.notifications = notif;
        }

        eventStore.addEvent({
          type: "system",
          title: "Notification config updated",
          detail: `Telegram Chat ID: ${telegramChatId ? "set" : "unchanged"}, Bot Token: ${telegramBotToken ? "set" : "unchanged"}`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "updated" });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });
}
