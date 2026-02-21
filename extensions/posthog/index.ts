import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PostHogPluginConfig } from "./src/types.js";
import { registerPostHogHooks } from "./src/plugin.js";

const DEFAULT_HOST = "https://us.i.posthog.com";

const plugin = {
  id: "posthog",
  name: "PostHog LLM Analytics",
  description: "Send LLM traces, generations, and tool spans to PostHog",
  register(api: OpenClawPluginApi) {
    const raw = api.pluginConfig ?? {};

    const traceGrouping = raw.traceGrouping === "session" ? "session" : "message";
    const sessionWindowMinutes =
      typeof raw.sessionWindowMinutes === "number" && raw.sessionWindowMinutes > 0
        ? raw.sessionWindowMinutes
        : 60;

    const config: PostHogPluginConfig = {
      apiKey: raw.apiKey as string,
      host: (raw.host as string) || DEFAULT_HOST,
      privacyMode: raw.privacyMode !== false,
      enabled: raw.enabled !== false,
      traceGrouping,
      sessionWindowMinutes,
    };

    if (!config.enabled) {
      api.logger.info("posthog: plugin disabled");
      return;
    }

    if (!config.apiKey) {
      api.logger.warn("posthog: missing apiKey, plugin will not capture events");
      return;
    }

    registerPostHogHooks(api, config);
  },
};

export default plugin;
