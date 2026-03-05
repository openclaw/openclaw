/**
 * SSE (Server-Sent Events) stream endpoint registration.
 * Each stream pushes periodic or event-driven JSON payloads to connected clients.
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { BacktestProgressStore } from "../strategy/backtest-progress-store.js";
import type { HttpRes } from "../types-http.js";
import type { ActivityLogStore } from "./activity-log-store.js";
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
  progressStore?: BacktestProgressStore,
  activityLog?: ActivityLogStore,
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

  // ── Agent activity log SSE (subscription-based) ──
  if (activityLog) {
    api.registerHttpRoute({
      path: "/api/v1/finance/agent-activity/stream",
      handler: async (req: { on: (event: string, cb: () => void) => void }, res: HttpRes) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // Send recent entries as initial payload
        res.write(
          `data: ${JSON.stringify({
            type: "initial",
            entries: activityLog.listRecent(50),
          })}\n\n`,
        );

        // Subscribe to new entries
        const unsubscribe = activityLog.subscribe((entry) => {
          res.write(
            `data: ${JSON.stringify({
              type: "new_entry",
              entry,
            })}\n\n`,
          );
        });

        req.on("close", () => {
          unsubscribe();
        });
      },
    });
  }

  // ── Backtest progress SSE (event-driven) ──
  if (progressStore) {
    api.registerHttpRoute({
      path: "/api/v1/finance/backtest/progress/stream",
      handler: async (req: { on: (event: string, cb: () => void) => void }, res: HttpRes) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Send current active backtests
        const active = progressStore.getActive();
        if (active.length > 0) {
          res.write(`data: ${JSON.stringify({ type: "active", backtests: active })}\n\n`);
        }
        // Subscribe to all progress updates
        const unsubscribe = progressStore.subscribe("*", (progress) => {
          res.write(`data: ${JSON.stringify({ type: "progress", ...progress })}\n\n`);
        });
        req.on("close", () => {
          unsubscribe();
        });
      },
    });
  }
}
