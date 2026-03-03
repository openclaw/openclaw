import type { BotPluginApi } from "bot/plugin-sdk";
import { emptyPluginConfigSchema } from "bot/plugin-sdk";
import { googlechatDock, googlechatPlugin } from "./src/channel.js";
import { setGoogleChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "googlechat",
  name: "Google Chat",
  description: "Bot Google Chat channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: BotPluginApi) {
    setGoogleChatRuntime(api.runtime);
    api.registerChannel({ plugin: googlechatPlugin, dock: googlechatDock });
  },
};

export default plugin;
