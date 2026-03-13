/**
 * Alert CRUD HTTP route handlers (list, create, remove).
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { AlertEngineLike, HttpReq, HttpRes, RuntimeServices } from "../types-http.js";
import { parseJsonBody, jsonResponse, errorResponse } from "../types-http.js";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";

export function registerAlertRoutes(
  api: OpenClawPluginApi,
  runtime: RuntimeServices,
  eventStore: AgentEventSqliteStore,
): void {
  // GET /api/v1/finance/alerts -- List all alerts
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/alerts",
    handler: async (_req: unknown, res: HttpRes) => {
      const alertEngine = runtime.services?.get?.("fin-alert-engine") as
        | AlertEngineLike
        | undefined;
      if (!alertEngine) {
        jsonResponse(res, 200, { alerts: [] });
        return;
      }
      jsonResponse(res, 200, { alerts: alertEngine.listAlerts() });
    },
  });

  // POST /api/v1/finance/alerts/create -- Create an alert
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/alerts/create",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { kind, symbol, price, threshold, direction, message } = body as Record<
          string,
          unknown
        >;

        if (!kind) {
          errorResponse(res, 400, "Missing required field: kind");
          return;
        }

        const alertEngine = runtime.services?.get?.("fin-alert-engine") as
          | AlertEngineLike
          | undefined;
        if (!alertEngine) {
          errorResponse(res, 503, "Alert engine not available");
          return;
        }

        const condition: Record<string, unknown> = { kind };
        if (symbol) condition.symbol = symbol;
        if (price != null) condition.price = price;
        if (threshold != null) condition.threshold = threshold;
        if (direction) condition.direction = direction;

        const alertId = alertEngine.addAlert(
          condition as Parameters<AlertEngineLike["addAlert"]>[0],
          message as string | undefined,
        );

        eventStore.addEvent({
          type: "alert_triggered",
          title: `Alert created: ${kind}`,
          detail: `${kind} alert for ${symbol ?? "portfolio"}`,
          status: "completed",
          narration: `已创建${kind}告警：${symbol ?? "组合"}。触发时我会第一时间通知你。`,
          feedType: "risk",
          chips: [
            { label: "Type", value: String(kind) },
            ...(symbol ? [{ label: "Symbol", value: String(symbol) }] : []),
          ],
        });

        jsonResponse(res, 201, { id: alertId, condition, message });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // POST /api/v1/finance/alerts/remove -- Remove an alert
  api.registerHttpRoute({
    auth: "plugin",
    path: "/api/v1/finance/alerts/remove",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { id } = body as { id?: string };

        if (!id) {
          errorResponse(res, 400, "Missing required field: id");
          return;
        }

        const alertEngine = runtime.services?.get?.("fin-alert-engine") as
          | AlertEngineLike
          | undefined;
        if (!alertEngine) {
          errorResponse(res, 503, "Alert engine not available");
          return;
        }

        const removed = alertEngine.removeAlert(id);
        if (!removed) {
          errorResponse(res, 404, `Alert ${id} not found`);
          return;
        }

        jsonResponse(res, 200, { status: "removed", id });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });
}
