import type { OpenClawPluginApi } from "openclaw/plugin-sdk/compat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/compat";
import { xPlugin } from "./src/plugin.js";
import { setXRuntime } from "./src/runtime.js";

const plugin = {
  id: "x",
  name: "X (Twitter)",
  description: "X (Twitter) channel plugin - monitor mentions and reply to tweets",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setXRuntime(api.runtime);
    api.registerChannel({ plugin: xPlugin as any });
  },
};

export default plugin;
