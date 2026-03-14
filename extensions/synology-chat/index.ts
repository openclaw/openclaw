import type { OpenClawPluginApi } from "openclaw/plugin-sdk/synology-chat";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelFactoryResult } from "../../src/plugins/lazy-channel.js";
import { setSynologyRuntime } from "./src/runtime.js";

const synologyChatPlugin = createLazyChannelFactoryResult({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "createSynologyChatPlugin",
  pluginId: "synology-chat",
});

const plugin = {
  id: "synology-chat",
  name: "Synology Chat",
  description: "Native Synology Chat channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSynologyRuntime(api.runtime);
    api.registerChannel({ plugin: synologyChatPlugin });
  },
};

export default plugin;
