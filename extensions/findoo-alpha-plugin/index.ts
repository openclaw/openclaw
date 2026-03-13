import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { A2AClient } from "./src/a2a-client.js";
import { resolveConfig } from "./src/config.js";
import { registerTools } from "./src/register-tools.js";

const findooPlugin = {
  id: "findoo-alpha-plugin",
  name: "Findoo Alpha",
  description:
    "Bridge to LangGraph strategy-agent via A2A protocol — " +
    "37 professional financial analysis skills covering A-shares, US/HK equities, crypto, macro, and risk.",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);
    const log = api.logger;

    // ── License Gate: no key → skip all registration ──
    if (!config.apiKey) {
      log.warn(
        "Findoo: license key not configured — plugin inactive. " +
          "Set FINDOO_API_KEY env var or configure in Control UI → Plugins → Findoo.",
      );
      return;
    }

    log.info(`findoo-alpha: connecting to ${config.strategyAgentUrl}`);
    log.info(`findoo-alpha: assistant ${config.strategyAssistantId}`);

    if (config.webhookUrl) {
      log.info(`findoo-alpha: webhook mode → ${config.webhookUrl}`);
    } else {
      log.info("findoo-alpha: sync fallback mode (no webhookUrl configured)");
    }

    const a2a = new A2AClient(config.strategyAgentUrl, config.strategyAssistantId);

    // Verify connectivity at startup (non-blocking)
    fetch(`${config.strategyAgentUrl}/ok`, {
      signal: AbortSignal.timeout(5_000),
    })
      .then((r) => {
        if (r.ok) {
          log.info("findoo-alpha: strategy-agent is reachable ✓");
        } else {
          log.warn(`findoo-alpha: strategy-agent returned ${r.status}`);
        }
      })
      .catch((err) => {
        log.warn(
          `findoo-alpha: strategy-agent unreachable (${err instanceof Error ? err.message : err}). Tools will retry on use.`,
        );
      });

    // Register A2A-bridged tools
    registerTools(api, config, a2a);

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
