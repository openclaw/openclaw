import type { OpenClawPluginApi } from "openclaw/plugin-sdk/zalo";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelDock, createLazyChannelPlugin } from "../../src/plugins/lazy-channel.js";
import { setZaloRuntime } from "./src/runtime.js";

const zaloPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "zaloPlugin",
  pluginId: "zalo",
});
const zaloDock = createLazyChannelDock({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "zaloDock",
});

const plugin = {
  id: "zalo",
  name: "Zalo",
  description: "Zalo channel plugin (Bot API)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setZaloRuntime(api.runtime);
    api.registerChannel({ plugin: zaloPlugin, dock: zaloDock });
  },
};

export default plugin;
