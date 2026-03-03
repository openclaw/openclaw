/**
 * Daily brief HTTP route handlers (generate + get cached).
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { DailyBriefGenerator } from "./daily-brief.js";
import type { HttpRes } from "./types-http.js";
import { jsonResponse } from "./types-http.js";

export function registerBriefRoutes(
  api: OpenClawPluginApi,
  briefGenerator: DailyBriefGenerator,
): void {
  // POST /api/v1/finance/agent/brief — (Re)generate daily brief
  api.registerHttpRoute({
    path: "/api/v1/finance/agent/brief",
    handler: async (_req: unknown, res: HttpRes) => {
      try {
        const brief = await briefGenerator.generate();
        jsonResponse(res, 200, { brief });
      } catch (err) {
        jsonResponse(res, 500, { error: (err as Error).message });
      }
    },
  });

  // GET /api/v1/finance/agent/brief/cached — Get last generated brief
  api.registerHttpRoute({
    path: "/api/v1/finance/agent/brief/cached",
    handler: async (_req: unknown, res: HttpRes) => {
      const brief = briefGenerator.getCachedBrief();
      jsonResponse(res, 200, { brief });
    },
  });
}
