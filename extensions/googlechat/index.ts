import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { googlechatDock, googlechatPlugin } from "./src/channel.js";
import { setGoogleChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "googlechat",
  name: "Google Chat",
  description: "OpenClaw Google Chat channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setGoogleChatRuntime(api.runtime);
    api.registerChannel({ plugin: googlechatPlugin, dock: googlechatDock });
  },
};

export default plugin;
