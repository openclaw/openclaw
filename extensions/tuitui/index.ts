import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { tuituiDock, tuituiPlugin } from "./src/channel.js";
import { setTuituiRuntime } from "./src/runtime.js";
import { handleTuituiWebhookRequest } from "./src/webhook.js";

const plugin = {
  id: "tuitui",
  name: "推推",
  description: "推推 (Tuitui) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTuituiRuntime(api.runtime);
    api.registerChannel({ plugin: tuituiPlugin, dock: tuituiDock });
    api.registerHttpHandler(handleTuituiWebhookRequest);
  },
};

export default plugin;
