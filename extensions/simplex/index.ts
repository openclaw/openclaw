import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { simplexPlugin } from "./src/channel.js";
import type { SimplexConfig } from "./src/config-schema.js";
import { setSimplexRuntime } from "./src/runtime.js";
import type { ResolvedSimplexAccount } from "./src/types.js";

const plugin = {
  id: "simplex",
  name: "SimpleX Chat",
  description: "SimpleX Chat channel — zero-metadata encrypted DMs via local CLI WebSocket",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSimplexRuntime(api.runtime);
    api.registerChannel({ plugin: simplexPlugin });
    api.logger.info("SimpleX Chat plugin registered");
  },
};

export default plugin;

// Re-export types for external use
export type { ResolvedSimplexAccount, SimplexConfig };
