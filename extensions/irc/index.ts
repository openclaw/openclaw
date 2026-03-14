import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/irc";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin } from "../../src/plugins/lazy-channel.js";
import { setIrcRuntime } from "./src/runtime.js";

const ircPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "ircPlugin",
  pluginId: "irc",
});

const plugin = {
  id: "irc",
  name: "IRC",
  description: "IRC channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setIrcRuntime(api.runtime);
    api.registerChannel({ plugin: ircPlugin as ChannelPlugin });
  },
};

export default plugin;
