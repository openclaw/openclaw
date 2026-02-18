import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { keybasePlugin } from "./src/channel.js";
import { setKeybaseRuntime } from "./src/runtime.js";

const plugin = {
  id: "keybase",
  name: "Keybase",
  description: "Keybase channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setKeybaseRuntime(api.runtime);
    api.registerChannel({ plugin: keybasePlugin });
  },
};

export default plugin;
