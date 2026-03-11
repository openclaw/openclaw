import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createHyperionPluginService, type HyperionPluginConfig } from "./src/service.js";

const plugin = {
  id: "hyperion",
  name: "Hyperion Multi-Tenant Runtime",
  description: "Multi-tenant DynamoDB integration for the Nova Personal Assistant Platform.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as HyperionPluginConfig;

    api.registerService(createHyperionPluginService(pluginConfig));
  },
};

export default plugin;
