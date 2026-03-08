/**
 * HTTP route handler for the web dashboard.
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import url from "node:url";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { runBackfill, backfillSkillSessions, type BackfillResult } from "../backfill.js";
import {
  queryUsage,
  querySkillHealth,
  queryStatus,
  querySkillSessions,
  type QueryParams,
} from "../query.js";
import type { UsageStorage, SkillSessionStorage } from "../storage.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "dashboard.html");

let cachedHtml: string | null = null;
function readHtml(): string {
  if (!cachedHtml) {
    cachedHtml = fs.readFileSync(HTML_PATH, "utf-8");
  }
  return cachedHtml;
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

export function createDashboardHandler(params: {
  storage: UsageStorage;
  skillSessionStorage: SkillSessionStorage;
  sessionsDir: string;
  agentId: string;
  logger: PluginLogger;
}) {
  const { storage, skillSessionStorage, sessionsDir, agentId, logger } = params;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const parsed = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const subPath = parsed.pathname.replace(/^\/plugins\/usage-tracker\/?/, "");

      if (subPath === "api" || subPath === "api/") {
        const action = parsed.searchParams.get("action") ?? "status";
        const startDay = parsed.searchParams.get("startDay") ?? undefined;
        const endDay = parsed.searchParams.get("endDay") ?? undefined;

        if (action === "backfill" && req.method === "POST") {
          const [usageResult, sessionResult] = await Promise.all([
            runBackfill({ sessionsDir, agentId, storage, logger }),
            backfillSkillSessions({ sessionsDir, agentId, skillSessionStorage, logger }),
          ]);
          sendJson(res, {
            ...usageResult,
            skillSessionsFound: sessionResult.skillSessionsFound,
          });
          return;
        }

        if (action === "status") {
          sendJson(res, await queryStatus(storage));
          return;
        }

        if (action === "skill_health") {
          sendJson(res, await querySkillHealth(storage, { startDay, endDay }));
          return;
        }

        if (action === "skill_sessions") {
          sendJson(res, await querySkillSessions(skillSessionStorage));
          return;
        }

        const queryParams: QueryParams = {
          startDay,
          endDay,
          tool: parsed.searchParams.get("tool") ?? undefined,
          skill: parsed.searchParams.get("skill") ?? undefined,
          groupBy: (parsed.searchParams.get("groupBy") as QueryParams["groupBy"]) ?? undefined,
        };
        sendJson(res, await queryUsage(storage, queryParams));
        return;
      }

      sendHtml(res, readHtml());
    } catch (err) {
      logger.error(`usage-tracker dashboard error: ${String(err)}`);
      sendJson(res, { error: String(err) }, 500);
    }
  };
}
