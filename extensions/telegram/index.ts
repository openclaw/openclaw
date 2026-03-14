import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/telegram";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin } from "../../src/plugins/lazy-channel.js";
import { setTelegramRuntime } from "./src/runtime.js";

const telegramPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "telegramPlugin",
  pluginId: "telegram",
});

const plugin = {
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTelegramRuntime(api.runtime);
    api.registerChannel({ plugin: telegramPlugin as ChannelPlugin });
  },
};

export default plugin;
