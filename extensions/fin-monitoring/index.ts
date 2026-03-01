import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { AlertEngine } from "./src/alert-engine.js";
import type { AlertCondition } from "./src/alert-engine.js";
import { AlertStore } from "./src/alert-store.js";

type MarketDataTicker = {
  last?: number;
  close?: number;
  bid?: number;
  ask?: number;
};

type DataProvider = {
  getTicker: (
    symbol: string,
    market: "crypto" | "equity" | "commodity",
  ) => Promise<MarketDataTicker>;
};

type MonitoringConfig = {
  autoEvaluate: boolean;
  runOnStart: boolean;
  pollIntervalMs: number;
};

function readEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

/** Infer market type from symbol format. Crypto pairs contain '/', equities are bare tickers. */
function inferMarket(symbol: string): "crypto" | "equity" | "commodity" {
  if (symbol.includes("/")) return "crypto";
  // Common commodity symbols
  const commodities = ["XAUUSD", "XAGUSD", "WTIUSD", "BRENTUSD"];
  if (commodities.includes(symbol.toUpperCase())) return "commodity";
  return "equity";
}

function resolveMonitoringConfig(api: OpenClawPluginApi): MonitoringConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const autoRaw =
    typeof raw.autoEvaluate === "boolean"
      ? String(raw.autoEvaluate)
      : readEnv(["OPENFINCLAW_FIN_MONITORING_AUTO_EVALUATE", "FIN_MONITORING_AUTO_EVALUATE"]);
  const startRaw =
    typeof raw.runOnStart === "boolean"
      ? String(raw.runOnStart)
      : readEnv(["OPENFINCLAW_FIN_MONITORING_RUN_ON_START", "FIN_MONITORING_RUN_ON_START"]);
  const pollRaw =
    raw.pollIntervalMs ??
    readEnv(["OPENFINCLAW_FIN_MONITORING_POLL_INTERVAL_MS", "FIN_MONITORING_POLL_INTERVAL_MS"]);
  const poll = Number(pollRaw);
  const pollIntervalMs = Number.isFinite(poll) && poll >= 10_000 ? Math.floor(poll) : 5 * 60_000;

  return {
    autoEvaluate: parseBool(autoRaw, true),
    runOnStart: parseBool(startRaw, true),
    pollIntervalMs,
  };
}

function extractTickerPrice(ticker: MarketDataTicker): number | null {
  if (typeof ticker.last === "number") return ticker.last;
  if (typeof ticker.close === "number") return ticker.close;
  if (typeof ticker.bid === "number" && typeof ticker.ask === "number") {
    return (ticker.bid + ticker.ask) / 2;
  }
  return null;
}

const finMonitoringPlugin = {
  id: "fin-monitoring",
  name: "Financial Monitoring",
  description:
    "Proactive financial monitoring: price alerts, portfolio health checks, scheduled reports",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const storePath = api.resolvePath("state/fin-alerts.sqlite");
    const alertStore = new AlertStore(storePath);
    const alertEngine = new AlertEngine(alertStore);
    const config = resolveMonitoringConfig(api);
    const runtime = api.runtime as unknown as { services?: Map<string, unknown> };
    let checking = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const evaluatePriceAlerts = async () => {
      const active = alertEngine
        .listAlerts()
        .filter((a) => !a.triggeredAt)
        .filter(
          (a) => a.condition.kind === "price_above" || a.condition.kind === "price_below",
        ) as Array<{ id: string; condition: Extract<AlertCondition, { symbol: string }> }>;

      if (active.length === 0) {
        return {
          checkedAlerts: 0,
          checkedSymbols: 0,
          triggeredCount: 0,
          triggeredAlerts: [],
        };
      }

      const provider = runtime.services?.get?.("fin-data-provider") as DataProvider | undefined;
      if (!provider || typeof provider.getTicker !== "function") {
        throw new Error(
          "fin-data-provider service unavailable. Enable findoo-datahub-plugin to auto-evaluate price alerts.",
        );
      }

      const symbols = [...new Set(active.map((a) => a.condition.symbol))];
      const triggered = [];
      for (const symbol of symbols) {
        const market = inferMarket(symbol);
        const ticker = await provider.getTicker(symbol, market);
        const price = extractTickerPrice(ticker);
        if (price == null) {
          continue;
        }
        triggered.push(...alertEngine.checkPrice(symbol, price));
      }

      return {
        checkedAlerts: active.length,
        checkedSymbols: symbols.length,
        triggeredCount: triggered.length,
        triggeredAlerts: triggered,
      };
    };

    const runScheduledEvaluation = async () => {
      if (checking) return;
      checking = true;
      try {
        const result = await evaluatePriceAlerts();
        if (result.triggeredCount > 0) {
          api.logger.info(
            `fin-monitoring: triggered ${result.triggeredCount} alert(s) on ${result.checkedSymbols} symbol(s)`,
          );
        }
      } catch (err) {
        api.logger.warn(
          `fin-monitoring: scheduled alert evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        checking = false;
      }
    };

    // Expose the alert engine for other fin-* plugins to consume.
    api.registerService({
      id: "fin-alert-engine",
      start: () => {},
      instance: alertEngine,
    } as Parameters<typeof api.registerService>[0]);

    api.registerService({
      id: "fin-monitoring-scheduler",
      start: () => {
        if (!config.autoEvaluate) {
          return;
        }
        if (config.runOnStart) {
          void runScheduledEvaluation();
        }
        timer = setInterval(() => {
          void runScheduledEvaluation();
        }, config.pollIntervalMs);
      },
      stop: () => {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        alertStore.close();
      },
      instance: {
        triggerNow: runScheduledEvaluation,
      },
    } as Parameters<typeof api.registerService>[0]);

    // --- fin_set_alert ---
    api.registerTool(
      {
        name: "fin_set_alert",
        label: "Set Alert",
        description:
          "Create a price or P&L alert. Supported kinds: price_above, price_below, pnl_threshold.",
        parameters: Type.Object({
          kind: Type.Unsafe<"price_above" | "price_below" | "pnl_threshold">({
            type: "string",
            enum: ["price_above", "price_below", "pnl_threshold"],
            description: "Alert condition kind",
          }),
          symbol: Type.Optional(
            Type.String({
              description: "Trading pair symbol (e.g. BTC/USDT). Required for price alerts.",
            }),
          ),
          price: Type.Optional(
            Type.Number({
              description:
                "Target price that triggers the alert. Required for price_above / price_below.",
            }),
          ),
          threshold: Type.Optional(
            Type.Number({
              description: "P&L threshold in USD. Required for pnl_threshold.",
            }),
          ),
          direction: Type.Optional(
            Type.Unsafe<"loss" | "gain">({
              type: "string",
              enum: ["loss", "gain"],
              description: "P&L direction for pnl_threshold alerts.",
            }),
          ),
          message: Type.Optional(
            Type.String({ description: "Custom message to include when the alert fires." }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const kind = params.kind as string;
          const message = params.message as string | undefined;

          let condition: AlertCondition;

          if (kind === "price_above" || kind === "price_below") {
            const symbol = params.symbol as string | undefined;
            const price = params.price as number | undefined;
            if (!symbol || price == null) {
              const err = { error: "symbol and price are required for price alerts" };
              return {
                content: [{ type: "text" as const, text: JSON.stringify(err) }],
                details: err,
              };
            }
            condition = { kind, symbol, price };
          } else if (kind === "pnl_threshold") {
            const threshold = params.threshold as number | undefined;
            const direction = (params.direction as "loss" | "gain" | undefined) ?? "loss";
            if (threshold == null) {
              const err = { error: "threshold is required for pnl_threshold alerts" };
              return {
                content: [{ type: "text" as const, text: JSON.stringify(err) }],
                details: err,
              };
            }
            condition = { kind, threshold, direction };
          } else {
            const err = { error: `Unknown alert kind: ${kind}` };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(err) }],
              details: err,
            };
          }

          const id = alertEngine.addAlert(condition, message);
          const result = { id, condition, message, status: "active" };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { names: ["fin_set_alert"] },
    );

    // --- fin_list_alerts ---
    api.registerTool(
      {
        name: "fin_list_alerts",
        label: "List Alerts",
        description: "List all active and triggered financial alerts.",
        parameters: Type.Object({}),
        async execute() {
          const alerts = alertEngine.listAlerts();
          const result = {
            total: alerts.length,
            active: alerts.filter((a) => !a.triggeredAt).length,
            triggered: alerts.filter((a) => !!a.triggeredAt).length,
            alerts,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      },
      { names: ["fin_list_alerts"] },
    );

    // --- fin_remove_alert ---
    api.registerTool(
      {
        name: "fin_remove_alert",
        label: "Remove Alert",
        description: "Remove an alert by its ID.",
        parameters: Type.Object({
          id: Type.String({ description: "Alert ID to remove (e.g. alert-1)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const alertId = params.id as string;
          const removed = alertEngine.removeAlert(alertId);
          const result = {
            id: alertId,
            removed,
            message: removed ? "Alert removed" : "Alert not found",
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      },
      { names: ["fin_remove_alert"] },
    );

    // --- fin_monitor_run_checks ---
    api.registerTool(
      {
        name: "fin_monitor_run_checks",
        label: "Run Monitoring Checks",
        description:
          "Run monitoring checks now (price alerts, optional P&L threshold alerts) and return trigger results.",
        parameters: Type.Object({
          pnlUsd: Type.Optional(
            Type.Number({
              description: "Current P&L in USD. If provided, pnl_threshold alerts are evaluated.",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const priceResult = await evaluatePriceAlerts();
            const pnlUsd = typeof params.pnlUsd === "number" ? params.pnlUsd : undefined;
            const pnlTriggered = pnlUsd == null ? [] : alertEngine.checkPnl(pnlUsd);

            const result = {
              ...priceResult,
              pnlUsd,
              pnlTriggeredCount: pnlTriggered.length,
              pnlTriggeredAlerts: pnlTriggered,
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
              details: result,
            };
          } catch (err) {
            const error = { error: err instanceof Error ? err.message : String(err) };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(error) }],
              details: error,
            };
          }
        },
      },
      { names: ["fin_monitor_run_checks"] },
    );
  },
};

export default finMonitoringPlugin;
