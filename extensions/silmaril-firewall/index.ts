import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSilmarilFirewallAgentToolResultMiddleware } from "./tool-result-middleware.js";

export default definePluginEntry({
  id: "silmaril-firewall",
  name: "Silmaril Firewall",
  description:
    "Classifies and optionally replaces malicious agent tool results before model reuse.",
  register(api) {
    api.registerAgentToolResultMiddleware(
      createSilmarilFirewallAgentToolResultMiddleware(api.pluginConfig, api.logger),
      {
        runtimes: ["pi", "codex"],
      },
    );
  },
});

export {
  createSilmarilFirewallAgentToolResultMiddleware,
  __testInternals,
} from "./tool-result-middleware.js";
