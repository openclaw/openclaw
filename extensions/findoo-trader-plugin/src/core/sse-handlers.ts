/**
 * SSE (Server-Sent Events) stream endpoint registration.
 * Each stream pushes periodic or event-driven JSON payloads to connected clients.
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { HttpRes } from "../types-http.js";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import type { DataGatheringDeps } from "./data-gathering.js";
import {
  gatherFinanceConfigData,
  gatherTradingData,
  gatherStrategyData,
} from "./data-gathering.js";

export function registerSseRoutes(
  api: OpenClawPluginApi,
  deps: DataGatheringDeps,
  eventStore: AgentEventSqliteStore,
): void {
  // ── Finance config SSE (30s interval) ──
  api.registerHttpRoute({
    path: "/api/v1/finance/config/stream",
    handler: async (req: { on: (event: string, cb: () => void) => void }, res: HttpRes) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(gatherFinanceConfigData(deps))}\n\n`);
      const interval = setInterval(() => {
        res.write(`data: ${JSON.stringify(gatherFinanceConfigData(deps))}\n\n`);
      }, 30000);
      req.on("close", () => clearInterval(interval));
    },
  });

  // ── Trading data SSE (10s interval) ──
  api.registerHttpRoute({
    path: "/api/v1/finance/trading/stream",
    handler: async (req: { on: (event: string, cb: () => void) => void }, res: HttpRes) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(gatherTradingData(deps))}\n\n`);
      const interval = setInterval(() => {
        res.write(`data: ${JSON.stringify(gatherTradingData(deps))}\n\n`);
      }, 10000);
      req.on("close", () => clearInterval(interval));
    },
  });

  // ── Agent events SSE (subscription-based) ──
  api.registerHttpRoute({
    path: "/api/v1/finance/events/stream",
    handler: async (req: { on: (event: string, cb: () => void) => void }, res: HttpRes) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send current events as initial payload
      res.write(
        `data: ${JSON.stringify({
          events: eventStore.listEvents(),
          pendingCount: eventStore.pendingCount(),
        })}\n\n`,
      );

      // Subscribe to new events
      const unsubscribe = eventStore.subscribe((event) => {
        res.write(
          `data: ${JSON.stringify({
            type: "new_event",
            event,
            pendingCount: eventStore.pendingCount(),
          })}\n\n`,
        );
      });

      req.on("close", () => {
        unsubscribe();
      });
    },
  });

  // ── Strategy data SSE (15s interval) ──
  api.registerHttpRoute({
    path: "/api/v1/finance/strategy/stream",
    handler: async (req: { on: (event: string, cb: () => void) => void }, res: HttpRes) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(gatherStrategyData(deps))}\n\n`);
      const interval = setInterval(() => {
        res.write(`data: ${JSON.stringify(gatherStrategyData(deps))}\n\n`);
      }, 15000);
      req.on("close", () => clearInterval(interval));
    },
  });
}
