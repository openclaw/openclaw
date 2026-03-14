import type { OpenClawPluginApi } from "openclaw/plugin-sdk/twitch";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin } from "../../src/plugins/lazy-channel.js";
import { setTwitchRuntime } from "./src/runtime.js";

const twitchPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/plugin.js",
  exportName: "twitchPlugin",
  pluginId: "twitch",
});

const plugin = {
  id: "twitch",
  name: "Twitch",
  description: "Twitch channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTwitchRuntime(api.runtime);
    api.registerChannel({ plugin: twitchPlugin as any });
  },
};

export default plugin;
