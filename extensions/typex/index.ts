import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { typexPlugin } from "./src/channel.js";
import { setTypeXRuntime } from "./src/client/runtime.js";

const plugin = {
  id: "typex",
  name: "TypeX",
  description: "TypeX channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTypeXRuntime(api.runtime);
    api.registerChannel({ plugin: typexPlugin });
  },
};

export default plugin;
