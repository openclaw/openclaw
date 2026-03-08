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
  notificationFilterSchema,
  configImportSchema,
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

  // ── GET/POST /api/v1/finance/exchanges — List or add exchange ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/exchanges",
    handler: async (req: HttpReq, res: HttpRes) => {
      if (req.method === "GET") {
        const exchanges = registry.listExchanges().map((e) => ({
          id: e.id,
          exchange: e.exchange,
          testnet: e.testnet ?? false,
        }));
        const health = healthStore.listAll();
        jsonResponse(res, 200, { exchanges, health });
        return;
      }
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
    auth: "plugin",
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

  // ── POST /api/v1/finance/exchanges/update — Update exchange credentials ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/exchanges/update",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { id, apiKey, secret, passphrase, testnet, label } = body as {
          id?: string;
          apiKey?: string;
          secret?: string;
          passphrase?: string;
          testnet?: boolean;
          label?: string;
        };

        if (!id) {
          errorResponse(res, 400, "Missing required field: id");
          return;
        }

        const existing = registry.getConfig(id);
        if (!existing) {
          errorResponse(res, 404, `Exchange "${id}" not found`);
          return;
        }

        // Merge: only overwrite fields that were provided (non-empty)
        registry.addExchange(id, {
          ...existing,
          ...(apiKey ? { apiKey } : {}),
          ...(secret ? { secret } : {}),
          ...(passphrase !== undefined ? { passphrase } : {}),
          ...(testnet !== undefined ? { testnet } : {}),
        });

        eventStore.addEvent({
          type: "system",
          title: `Exchange updated: ${id}`,
          detail: `${existing.exchange}${testnet ? " (testnet)" : ""} credentials updated`,
          status: "completed",
        });

        jsonResponse(res, 200, { id, status: "updated" });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── DELETE /api/v1/finance/exchanges/:id — Remove exchange ──
  // (Using POST with body since some routers don't support DELETE well)
  api.registerHttpRoute({
    auth: "plugin",
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

  // ── GET/PUT /api/v1/finance/config/trading — Read or update risk/trading config ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/trading",
    handler: async (req: HttpReq, res: HttpRes) => {
      if (req.method === "GET") {
        jsonResponse(res, 200, riskController.getConfig());
        return;
      }
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

  // ── GET/PUT /api/v1/finance/config/agent — Read or update agent behavior config ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/agent",
    handler: async (req: HttpReq, res: HttpRes) => {
      if (req.method === "GET") {
        const configStore = runtime.services?.get?.("fin-agent-config") as
          | { getConfig?: () => Record<string, unknown> }
          | undefined;
        jsonResponse(res, 200, configStore?.getConfig?.() ?? {});
        return;
      }
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

  // ── GET/PUT /api/v1/finance/config/gates — Read or update promotion gate thresholds ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/gates",
    handler: async (req: HttpReq, res: HttpRes) => {
      if (req.method === "GET") {
        const configStore = runtime.services?.get?.("fin-gate-config") as
          | { getConfig?: () => Record<string, unknown> }
          | undefined;
        jsonResponse(res, 200, configStore?.getConfig?.() ?? {});
        return;
      }
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

  // ── GET /api/v1/finance/config/notifications — Read notification config ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/notifications",
    handler: async (_req: HttpReq, res: HttpRes) => {
      try {
        const pluginConfig = (api as unknown as { pluginConfig?: Record<string, unknown> })
          .pluginConfig;
        const notif = (pluginConfig?.notifications ?? {}) as Record<string, unknown>;
        // Mask sensitive tokens — only reveal presence
        const safe = {
          telegramBotToken: notif.telegramBotToken ? "***configured***" : null,
          telegramChatId: notif.telegramChatId ?? null,
          discordWebhookUrl: notif.discordWebhookUrl ? "***configured***" : null,
          emailHost: notif.emailHost ?? null,
          emailPort: notif.emailPort ?? 587,
          emailFrom: notif.emailFrom ?? null,
          emailTo: notif.emailTo ?? null,
          enabledEvents: notif.enabledEvents ?? null,
        };
        jsonResponse(res, 200, safe);
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── PUT /api/v1/finance/config/notifications — Update notification config ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/notifications",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
        const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);

        const telegramBotToken = str(body.telegramBotToken);
        const telegramChatId = str(body.telegramChatId);
        const discordWebhookUrl = str(body.discordWebhookUrl);
        const emailHost = str(body.emailHost);
        const emailPort = num(body.emailPort, 587);
        const emailFrom = str(body.emailFrom);
        const emailTo = str(body.emailTo);

        // Persist via the plugin config store if available
        const pluginConfig = (api as unknown as { pluginConfig?: Record<string, unknown> })
          .pluginConfig;
        if (pluginConfig) {
          const notif = (pluginConfig.notifications ?? {}) as Record<string, unknown>;
          if (telegramBotToken !== undefined) notif.telegramBotToken = telegramBotToken;
          if (telegramChatId !== undefined) notif.telegramChatId = telegramChatId;
          if (discordWebhookUrl !== undefined) notif.discordWebhookUrl = discordWebhookUrl;
          if (emailHost !== undefined) notif.emailHost = emailHost;
          if (body.emailPort !== undefined) notif.emailPort = emailPort;
          if (emailFrom !== undefined) notif.emailFrom = emailFrom;
          if (emailTo !== undefined) notif.emailTo = emailTo;
          pluginConfig.notifications = notif;
        }

        const channels: string[] = [];
        if (telegramChatId || telegramBotToken) channels.push("Telegram");
        if (discordWebhookUrl) channels.push("Discord");
        if (emailHost || emailFrom || emailTo) channels.push("Email");

        eventStore.addEvent({
          type: "system",
          title: "Notification config updated",
          detail: channels.length
            ? `Channels updated: ${channels.join(", ")}`
            : "Notification config saved (no channel changes)",
          status: "completed",
        });

        jsonResponse(res, 200, { status: "updated" });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── GET /api/v1/finance/config/notification-filters — Read notification event filters ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/notification-filters",
    handler: async (_req: HttpReq, res: HttpRes) => {
      try {
        const pluginConfig = (api as unknown as { pluginConfig?: Record<string, unknown> })
          .pluginConfig;
        const notif = (pluginConfig?.notifications ?? {}) as Record<string, unknown>;
        jsonResponse(res, 200, {
          enabledEvents: notif.enabledEvents ?? [],
        });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── PUT /api/v1/finance/config/notification-filters — Update notification event filters ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/notification-filters",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const parsed = notificationFilterSchema.safeParse(body);
        if (!parsed.success) {
          errorResponse(res, 400, parsed.error.issues.map((i) => i.message).join("; "));
          return;
        }

        const pluginConfig = (api as unknown as { pluginConfig?: Record<string, unknown> })
          .pluginConfig;
        if (pluginConfig) {
          const notif = (pluginConfig.notifications ?? {}) as Record<string, unknown>;
          notif.enabledEvents = parsed.data.enabledEvents;
          pluginConfig.notifications = notif;
        }

        eventStore.addEvent({
          type: "system",
          title: "Notification filters updated",
          detail: `Enabled events: ${parsed.data.enabledEvents.join(", ")}`,
          status: "completed",
        });

        jsonResponse(res, 200, {
          status: "updated",
          enabledEvents: parsed.data.enabledEvents,
        });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── GET /api/v1/finance/config/export — Export full finance configuration ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/export",
    handler: async (_req: HttpReq, res: HttpRes) => {
      try {
        const pluginConfig = (api as unknown as { pluginConfig?: Record<string, unknown> })
          .pluginConfig;

        const riskCfg = riskController.getConfig();
        const exchanges = registry.listExchanges().map((e) => ({
          id: e.id,
          exchange: e.exchange,
          testnet: e.testnet ?? false,
        }));

        const agentConfigStore = runtime.services?.get?.("fin-agent-config") as
          | { getConfig?: () => Record<string, unknown> }
          | undefined;
        const gateConfigStore = runtime.services?.get?.("fin-gate-config") as
          | { getConfig?: () => Record<string, unknown> }
          | undefined;

        jsonResponse(res, 200, {
          risk: riskCfg,
          exchanges,
          agent: agentConfigStore?.getConfig?.() ?? null,
          gates: gateConfigStore?.getConfig?.() ?? null,
          notifications: pluginConfig?.notifications ?? null,
          exportedAt: new Date().toISOString(),
          version: "1.0",
        });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── POST /api/v1/finance/config/import — Import finance configuration ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/import",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const parsed = configImportSchema.safeParse(body);
        if (!parsed.success) {
          errorResponse(res, 400, parsed.error.issues.map((i) => i.message).join("; "));
          return;
        }

        const imported: string[] = [];

        if (parsed.data.risk) {
          riskController.updateConfig(parsed.data.risk);
          imported.push("risk");
        }

        if (parsed.data.agent) {
          const agentConfigStore = runtime.services?.get?.("fin-agent-config") as
            | { update: (cfg: Record<string, unknown>) => void }
            | undefined;
          if (agentConfigStore?.update) {
            agentConfigStore.update(parsed.data.agent);
            imported.push("agent");
          }
        }

        if (parsed.data.gates) {
          const gateConfigStore = runtime.services?.get?.("fin-gate-config") as
            | { update: (cfg: Record<string, unknown>) => void }
            | undefined;
          if (gateConfigStore?.update) {
            gateConfigStore.update(parsed.data.gates);
            imported.push("gates");
          }
        }

        if (parsed.data.notifications) {
          const pluginConfig = (api as unknown as { pluginConfig?: Record<string, unknown> })
            .pluginConfig;
          if (pluginConfig) {
            const notif = (pluginConfig.notifications ?? {}) as Record<string, unknown>;
            Object.assign(notif, parsed.data.notifications);
            pluginConfig.notifications = notif;
            imported.push("notifications");
          }
        }

        eventStore.addEvent({
          type: "system",
          title: "Configuration imported",
          detail: `Imported sections: ${imported.join(", ") || "none"}`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "imported", sections: imported });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // ── POST /api/v1/finance/config/reset — Reset all config to defaults ──
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/config/reset",
    handler: async (_req: HttpReq, res: HttpRes) => {
      try {
        // Reset risk controller to balanced defaults
        riskController.updateConfig({
          enabled: true,
          maxAutoTradeUsd: 100,
          confirmThresholdUsd: 1000,
          maxDailyLossUsd: 500,
          maxPositionPct: 20,
          maxLeverage: 3,
        });

        // Clear all exchanges
        const exchanges = registry.listExchanges();
        for (const ex of exchanges) {
          registry.removeExchange(ex.id);
        }

        // Reset agent config
        const agentConfigStore = runtime.services?.get?.("fin-agent-config") as
          | { update: (cfg: Record<string, unknown>) => void }
          | undefined;
        if (agentConfigStore?.update) {
          agentConfigStore.update({
            heartbeatIntervalMs: 60000,
            discoveryEnabled: true,
            evolutionEnabled: true,
            mutationRate: 0.1,
            maxConcurrentStrategies: 10,
          });
        }

        // Reset gate config
        const gateConfigStore = runtime.services?.get?.("fin-gate-config") as
          | { update: (cfg: Record<string, unknown>) => void }
          | undefined;
        if (gateConfigStore?.update) {
          gateConfigStore.update({
            l0l1: {
              minDays: 7,
              minSharpe: 0.5,
              maxDrawdown: -0.15,
              minWinRate: 0.4,
              minTrades: 20,
            },
            l1l2: {
              minDays: 14,
              minSharpe: 1.0,
              maxDrawdown: -0.1,
              minWinRate: 0.45,
              minTrades: 50,
            },
            l2l3: {
              minDays: 30,
              minSharpe: 1.5,
              maxDrawdown: -0.08,
              minWinRate: 0.5,
              minTrades: 100,
            },
          });
        }

        // Clear notification config
        const pluginConfig = (api as unknown as { pluginConfig?: Record<string, unknown> })
          .pluginConfig;
        if (pluginConfig) {
          pluginConfig.notifications = {};
        }

        eventStore.addEvent({
          type: "system",
          title: "Configuration reset to defaults",
          detail:
            "All settings (risk, exchanges, agent, gates, notifications) reset to factory defaults",
          status: "completed",
        });

        jsonResponse(res, 200, { status: "reset", message: "All configuration reset to defaults" });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });
}
