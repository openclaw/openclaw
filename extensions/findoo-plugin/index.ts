import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveConfig } from "./src/config.js";
import { registerTools } from "./src/register-tools.js";

const findooPlugin = {
  id: "findoo-plugin",
  name: "Findoo",
  description:
    "Bridge to LangGraph strategy-agent via A2A protocol — " +
    "37 professional financial analysis skills covering A-shares, US/HK equities, crypto, macro, and risk.",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);

    api.log?.("info", `findoo-plugin: connecting to ${config.strategyAgentUrl}`);
    api.log?.("info", `findoo-plugin: assistant ${config.strategyAssistantId}`);

    // Verify connectivity at startup (non-blocking)
    fetch(`${config.strategyAgentUrl}/ok`, {
      signal: AbortSignal.timeout(5_000),
    })
      .then((r) => {
        if (r.ok) {
          api.log?.("info", "findoo-plugin: strategy-agent is reachable ✓");
        } else {
          api.log?.("warn", `findoo-plugin: strategy-agent returned ${r.status}`);
        }
      })
      .catch((err) => {
        api.log?.(
          "warn",
          `findoo-plugin: strategy-agent unreachable (${err instanceof Error ? err.message : err}). Tools will retry on use.`,
        );
      });

    // Register A2A-bridged tools
    registerTools(api, config);

    // Expose service for cross-plugin consumption
    api.runtime?.services?.set("fin-strategy-agent", {
      id: "fin-strategy-agent",
      getConfig: () => ({
        url: config.strategyAgentUrl,
        assistantId: config.strategyAssistantId,
      }),
    });
  },
};

export default findooPlugin;
