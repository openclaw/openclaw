import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveHermesBridgeConfig } from "./src/config.js";
import { createHermesBridgeHttpHandler } from "./src/http-route.js";
import { createHermesBridgeTool } from "./src/tool.js";

export default definePluginEntry({
  id: "hermes-bridge",
  name: "Hermes Bridge",
  description: "Local delegation bridge from Hermes Agent to OpenClaw task templates.",
  register(api) {
    const resolveConfig = () => resolveHermesBridgeConfig(api.pluginConfig);

    api.registerHttpRoute({
      path: "/api/plugins/hermes-bridge/tasks",
      auth: "gateway",
      match: "exact",
      handler: createHermesBridgeHttpHandler({
        resolveConfig,
        env: process.env,
      }),
    });

    api.registerTool(
      () => {
        const config = resolveConfig();
        if (!config.enabled) {
          return null;
        }
        return createHermesBridgeTool({ config });
      },
      { name: "hermes_bridge", optional: true },
    );
  },
});
