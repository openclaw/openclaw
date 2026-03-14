import type { OpenClawPluginApi } from "openclaw/plugin-sdk/signal";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin } from "../../src/plugins/lazy-channel.js";
import { setSignalRuntime } from "./src/runtime.js";

const signalPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "signalPlugin",
  pluginId: "signal",
});

const plugin = {
  id: "signal",
  name: "Signal",
  description: "Signal channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSignalRuntime(api.runtime);
    api.registerChannel({ plugin: signalPlugin });
  },
};

export default plugin;
