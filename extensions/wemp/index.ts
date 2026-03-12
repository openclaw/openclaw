import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { wempPlugin } from "./src/channel.js";
import { setWempRuntime } from "./src/runtime.js";
import { bindStorageRuntime } from "./src/storage.js";

const plugin = {
  id: "wemp",
  name: "WeChat Official Account",
  description: "WeChat Official Account channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    bindStorageRuntime(api.runtime);
    setWempRuntime(api.runtime);
    api.registerChannel({ plugin: wempPlugin });
  },
};

export default plugin;
