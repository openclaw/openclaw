/**
 * Usage Tracker Plugin — entry point.
 */

import path from "node:path";
import type { OpenClawPluginApi, GatewayRequestHandlerOptions } from "openclaw/plugin-sdk";
import { runBackfill, backfillSkillSessions } from "./src/backfill.js";
import { createAfterToolCallHandler } from "./src/hook.js";
import {
  queryUsage,
  querySkillHealth,
  queryStatus,
  querySkillSessions,
  type QueryParams,
} from "./src/query.js";
import { UsageStorage, SkillSessionStorage } from "./src/storage.js";
import { createUsageTrackerTool } from "./src/tool.js";
import { createDashboardHandler } from "./src/web/dashboard.js";

const DEFAULT_AGENT_ID = "main";

function resolveSessionsDir(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "sessions");
}

export default function register(api: OpenClawPluginApi) {
  const stateDir = api.runtime.state.resolveStateDir();
  const agentId = DEFAULT_AGENT_ID;
  const sessionsDir = resolveSessionsDir(stateDir, agentId);

  const storage = new UsageStorage(stateDir);
  const skillSessionStorage = new SkillSessionStorage(stateDir);
  api.logger.info(`usage-tracker: data dir: ${stateDir}/plugins/usage-tracker/data/`);

  // 1. Real-time tracking via after_tool_call hook
  const hookHandler = createAfterToolCallHandler(storage, api.logger);
  api.on("after_tool_call", hookHandler);

  // 2. Agent tool for in-conversation queries
  const tool = createUsageTrackerTool(storage, skillSessionStorage);
  api.registerTool(tool, { name: "usage_tracker" });

  // 3. Gateway RPC methods
  api.registerGatewayMethod(
    "usage-tracker.query",
    async ({ params, respond }: GatewayRequestHandlerOptions) => {
      try {
        const p = params ?? {};
        const queryParams: QueryParams = {
          startDay: typeof p.startDay === "string" ? p.startDay : undefined,
          endDay: typeof p.endDay === "string" ? p.endDay : undefined,
          tool: typeof p.tool === "string" ? p.tool : undefined,
          skill: typeof p.skill === "string" ? p.skill : undefined,
          groupBy:
            typeof p.groupBy === "string" ? (p.groupBy as QueryParams["groupBy"]) : undefined,
        };
        const result = await queryUsage(storage, queryParams);
        respond(true, result);
      } catch (err) {
        respond(false, undefined, { code: "error", message: String(err) });
      }
    },
  );

  api.registerGatewayMethod(
    "usage-tracker.backfill",
    async ({ respond }: GatewayRequestHandlerOptions) => {
      try {
        const [usageResult, sessionResult] = await Promise.all([
          runBackfill({ sessionsDir, agentId, storage, logger: api.logger }),
          backfillSkillSessions({ sessionsDir, agentId, skillSessionStorage, logger: api.logger }),
        ]);
        respond(true, {
          ...usageResult,
          skillSessionsFound: sessionResult.skillSessionsFound,
        });
      } catch (err) {
        respond(false, undefined, { code: "error", message: String(err) });
      }
    },
  );

  api.registerGatewayMethod(
    "usage-tracker.status",
    async ({ respond }: GatewayRequestHandlerOptions) => {
      try {
        const result = await queryStatus(storage);
        respond(true, result);
      } catch (err) {
        respond(false, undefined, { code: "error", message: String(err) });
      }
    },
  );

  // 4. Web dashboard — prefix match to handle /api sub-routes
  const dashboardHandler = createDashboardHandler({
    storage,
    skillSessionStorage,
    sessionsDir,
    agentId,
    logger: api.logger,
  });
  api.registerHttpRoute({
    path: "/plugins/usage-tracker",
    handler: dashboardHandler,
    auth: "plugin",
    match: "prefix",
  });
}
