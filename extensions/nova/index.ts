import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { novaPlugin } from "./src/channel.js";
import { setNovaRuntime } from "./src/runtime.js";

const plugin = {
  id: "nova",
  name: "Nova",
  description: "Nova channel plugin (nova.amazon.com)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setNovaRuntime(api.runtime);
    api.registerChannel({ plugin: novaPlugin });
  },
};

export default plugin;
