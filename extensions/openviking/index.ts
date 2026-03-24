import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  OpenVikingContextEngine,
  type OpenVikingPluginConfig,
} from "./src/openviking-context-engine.js";

const plugin = {
  id: "openviking",
  name: "OpenViking",
  description: "Use OpenViking as the unified context-engine retrieval layer.",
  kind: "context-engine",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerContextEngine("openviking", () => {
      const pluginConfig = (api.pluginConfig ?? {}) as OpenVikingPluginConfig;
      api.logger.info?.("openviking: context engine registered");
      return new OpenVikingContextEngine(pluginConfig, api.logger);
    });
  },
};

export default plugin;
