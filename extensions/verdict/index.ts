/** Verdict policy engine plugin for OpenClaw. */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/verdict";
import { createCliRegistrar } from "./src/cli.js";
import { VerdictClient } from "./src/client.js";
import { verdictConfigSchema, type VerdictPluginConfig } from "./src/config.js";
import { createBeforeToolCallHook } from "./src/hook.js";

const plugin = {
  id: "verdict",
  name: "Verdict",
  description:
    "Enforce business, security, and compliance policies on agent tool calls via the Verdict policy engine",
  configSchema: verdictConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as VerdictPluginConfig;

    if (!cfg.gatewayUrl) {
      api.logger.info("verdict: no gatewayUrl configured, plugin inactive");
      return;
    }

    const client = new VerdictClient({
      gatewayUrl: cfg.gatewayUrl,
      timeoutMs: cfg.timeoutMs,
    });

    // Register before_tool_call hook for policy evaluation
    api.on("before_tool_call", createBeforeToolCallHook(client, cfg, api.logger), {
      priority: 100, // High priority: evaluate policy before other hooks
    });

    // Register CLI commands (openclaw verdict health|policies|explain|traces)
    api.registerCli(createCliRegistrar(client), { commands: ["verdict"] });

    api.logger.info(
      `verdict: active (gateway=${cfg.gatewayUrl}, shadow=${cfg.shadowMode ?? false}, failOpen=${cfg.failOpen ?? true})`,
    );
  },
};

export default plugin;
