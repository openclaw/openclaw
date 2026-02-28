import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { dejoyPlugin } from "./src/channel.js";
import { setDeJoyRuntime } from "./src/runtime.js";

const plugin = {
  id: "dejoy",
  name: "DeJoy",
  description: "DeJoy channel plugin (same protocol as Matrix)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDeJoyRuntime(api.runtime);
    api.registerChannel({ plugin: dejoyPlugin });
  },
};

export default plugin;
