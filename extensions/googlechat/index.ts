import type { EasyHubPluginApi } from "EasyHub/plugin-sdk";
import { emptyPluginConfigSchema } from "EasyHub/plugin-sdk";
import { googlechatDock, googlechatPlugin } from "./src/channel.js";
import { handleGoogleChatWebhookRequest } from "./src/monitor.js";
import { setGoogleChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "googlechat",
  name: "Google Chat",
  description: "EasyHub Google Chat channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: EasyHubPluginApi) {
    setGoogleChatRuntime(api.runtime);
    api.registerChannel({ plugin: googlechatPlugin, dock: googlechatDock });
    api.registerHttpHandler(handleGoogleChatWebhookRequest);
  },
};

export default plugin;
