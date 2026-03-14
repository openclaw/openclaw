import type { OpenClawPluginApi } from "openclaw/plugin-sdk/imessage";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin } from "../../src/plugins/lazy-channel.js";
import { setIMessageRuntime } from "./src/runtime.js";

const imessagePlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "imessagePlugin",
  pluginId: "imessage",
});

const plugin = {
  id: "imessage",
  name: "iMessage",
  description: "iMessage channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setIMessageRuntime(api.runtime);
    api.registerChannel({ plugin: imessagePlugin });
  },
};

export default plugin;
