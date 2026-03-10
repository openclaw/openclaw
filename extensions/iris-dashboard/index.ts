import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { validateConfig } from "./src/config.js";
import { generateHeartbeat } from "./src/heartbeat.js";
import { handleApiRoutes } from "./src/routes-api.js";
import { createUiHandler } from "./src/routes-ui.js";
import { handleWebhookRoute } from "./src/routes-webhook.js";
import { createSupabaseClient } from "./src/supabase.js";

export default function register(api: OpenClawPluginApi) {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;
  if (!raw?.supabaseUrl || !raw?.supabaseServiceKey) {
    console.warn("[iris-dashboard] Missing supabaseUrl or supabaseServiceKey — plugin disabled.");
    return;
  }

  let config;
  try {
    config = validateConfig(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[iris-dashboard] Config validation failed: ${msg}`);
    return;
  }

  const client = createSupabaseClient(config);
  const handleUi = createUiHandler(config);

  const log = (msg: string) => api.logger.info?.(`[iris-dashboard] ${msg}`);

  // Handler for all /iris-dashboard/* requests
  api.registerHttpRoute({
    path: "/iris-dashboard",
    match: "prefix",
    auth: "plugin",
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      // 1. Try UI + static assets
      if (handleUi(req, res)) return true;

      // 2. Try API routes
      if (await handleApiRoutes(req, res, config, client)) return true;

      // 3. Try webhook
      if (
        await handleWebhookRoute(req, res, config, async (taskId) => {
          log(`Webhook: task ${taskId} completed`);
        })
      ) {
        return true;
      }

      return false;
    },
  });

  // Hook: generate HEARTBEAT.md on gateway start
  api.on("gateway_start", async (_event, _ctx) => {
    log("gateway_start — generating HEARTBEAT.md...");
    await generateHeartbeat(client, config, undefined as string | undefined);
  });

  // Hook: also generate on session_start as fallback (first session after cold boot)
  api.on("session_start", async (_event, _ctx) => {
    // Only run once per process lifecycle (guard via module-level flag)
    if (sessionStartFired) return;
    sessionStartFired = true;
    log("session_start — generating HEARTBEAT.md (fallback)...");
    await generateHeartbeat(client, config, undefined as string | undefined);
  });

  log("Plugin registered — serving at /iris-dashboard");
}

// Prevent repeated heartbeat from every session_start in the same process
let sessionStartFired = false;
