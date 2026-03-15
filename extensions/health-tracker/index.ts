import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/health-tracker";
import { STATE_DIR } from "openclaw/plugin-sdk/health-tracker";
import { HEALTH_TRACKER_GUIDANCE } from "./src/prompt-guidance.js";
import { HealthStore } from "./src/store.js";
import { createDailySummaryTool } from "./src/tools/daily-summary.js";
import { createFoodLookupTool } from "./src/tools/food-lookup.js";
import { createImportMfpTool } from "./src/tools/import-mfp.js";
import { createLogActivityTool } from "./src/tools/log-activity.js";
import { createLogFoodTool } from "./src/tools/log-food.js";
import { createLogWeightTool } from "./src/tools/log-weight.js";
import { createMacroStatusTool } from "./src/tools/macro-status.js";
import { createSetTargetsTool } from "./src/tools/set-targets.js";
import { createWhoopTool } from "./src/tools/whoop.js";
import { WhoopClient } from "./src/whoop-api.js";
import { createWhoopHttpHandler } from "./src/whoop-http.js";

const plugin = {
  id: "health-tracker",
  name: "Health Tracker",
  description:
    "Food logging, macro tracking, activity logging, Whoop integration, and daily health coaching.",
  register(api: OpenClawPluginApi) {
    const baseDir = path.join(STATE_DIR, "health-tracker");
    const store = new HealthStore(baseDir);
    const whoop = new WhoopClient(baseDir);

    // Resolve gateway base URL for Whoop OAuth callback
    const gatewayPort = api.config.gateway?.port ?? 18789;
    const gatewayBaseUrl = `http://localhost:${gatewayPort}`;

    const tools: AnyAgentTool[] = [
      createSetTargetsTool(store),
      createLogFoodTool(store),
      createFoodLookupTool(store),
      createMacroStatusTool(store),
      createLogActivityTool(store),
      createLogWeightTool(store),
      createImportMfpTool(store, baseDir),
      createDailySummaryTool(store),
      createWhoopTool(whoop, gatewayBaseUrl),
    ];

    for (const tool of tools) {
      api.registerTool(((_ctx) => tool) as OpenClawPluginToolFactory, { name: tool.name });
    }

    // Register Whoop OAuth callback HTTP route
    api.registerHttpRoute({
      path: "/plugins/health-tracker/whoop",
      auth: "plugin",
      match: "prefix",
      handler: createWhoopHttpHandler(whoop),
    });

    api.on("before_prompt_build", async () => ({
      appendSystemContext: HEALTH_TRACKER_GUIDANCE,
    }));
  },
};

export default plugin;
