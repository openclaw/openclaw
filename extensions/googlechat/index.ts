import type { OpenClawPluginApi } from "openclaw/plugin-sdk/googlechat";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelDock, createLazyChannelPlugin } from "../../src/plugins/lazy-channel.js";
import { setGoogleChatRuntime } from "./src/runtime.js";

const googlechatPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "googlechatPlugin",
  pluginId: "googlechat",
});
const googlechatDock = createLazyChannelDock({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "googlechatDock",
});

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
