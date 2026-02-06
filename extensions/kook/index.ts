import type { OpenClawPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { kookPlugin } from "./src/channel.js";
import { setKookRuntime } from "./src/runtime.js";

const plugin: OpenClawPlugin = {
  id: "kook-openclaw",
  name: "KOOK",
  description: "KOOK channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setKookRuntime(api.runtime);
    api.registerChannel({ plugin: kookPlugin });
  },
};

export default plugin;
