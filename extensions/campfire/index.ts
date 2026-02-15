import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { campfireDock, campfirePlugin } from "./src/channel.js";
import { handleCampfireWebhookRequest } from "./src/monitor.js";
import { setCampfireRuntime } from "./src/runtime.js";

const plugin = {
  id: "campfire",
  name: "Campfire",
  description: "OpenClaw Campfire channel plugin (37signals self-hosted chat)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setCampfireRuntime(api.runtime);
    api.registerChannel({ plugin: campfirePlugin, dock: campfireDock });
    api.registerHttpHandler(handleCampfireWebhookRequest);
  },
};

export default plugin;
