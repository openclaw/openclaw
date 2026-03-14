import type { OpenClawPluginApi } from "openclaw/plugin-sdk/discord";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin, loadLazyModuleExport } from "../../src/plugins/lazy-channel.js";
import { setDiscordRuntime } from "./src/runtime.js";

const discordPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "discordPlugin",
  pluginId: "discord",
});

const plugin = {
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDiscordRuntime(api.runtime);
    api.registerChannel({ plugin: discordPlugin });
    loadLazyModuleExport<(api: OpenClawPluginApi) => void>({
      importerUrl: import.meta.url,
      modulePath: "./src/subagent-hooks.js",
      exportName: "registerDiscordSubagentHooks",
    })(api);
  },
};

export default plugin;
