// Tokenjuice plugin entrypoint registers its OpenClaw integration.
import { normalizeAgentToolResultMiddlewareRuntimeIds } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createTokenjuiceAgentToolResultMiddleware } from "./tool-result-middleware.js";

export default definePluginEntry({
  id: "tokenjuice",
  name: "tokenjuice",
  description: "Compacts exec and bash tool results with tokenjuice reducers.",
  register(api) {
    api.registerAgentToolResultMiddleware(createTokenjuiceAgentToolResultMiddleware(), {
      runtimes: normalizeAgentToolResultMiddlewareRuntimeIds(
        manifest.contracts.agentToolResultMiddleware,
      ),
    });
  },
});
