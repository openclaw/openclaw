import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { parseAdaptiveThinkingConfig, resolveAdaptiveThinkingOverride } from "./src/logic.js";

const plugin = {
  id: "adaptive-thinking",
  name: "Adaptive Thinking",
  description: "Per-run thinking override plugin that adapts reasoning level from turn context.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const config = parseAdaptiveThinkingConfig(api.pluginConfig);
    api.on("before_model_resolve", async (event) => {
      const thinkingLevelOverride = resolveAdaptiveThinkingOverride({ config, event });
      if (!thinkingLevelOverride) {
        return undefined;
      }
      return { thinkingLevelOverride };
    });
  },
};

export default plugin;
