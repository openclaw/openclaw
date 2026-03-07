import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { gohighlevelDock, gohighlevelPlugin } from "./src/channel.js";
import { handleGoHighLevelWebhookRequest } from "./src/monitor.js";
import { setGoHighLevelRuntime } from "./src/runtime.js";

const plugin = {
  id: "gohighlevel",
  name: "GoHighLevel",
  description: "OpenClaw GoHighLevel channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setGoHighLevelRuntime(api.runtime);
    api.registerChannel({ plugin: gohighlevelPlugin, dock: gohighlevelDock });
    api.registerHttpHandler(handleGoHighLevelWebhookRequest);
  },
};

export default plugin;
