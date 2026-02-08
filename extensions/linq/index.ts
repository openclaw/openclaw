import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { linqPlugin } from "./src/channel.js";
import { setLinqRuntime } from "./src/runtime.js";

const plugin = {
  id: "linq",
  name: "LINQ",
  description: "LINQ channel plugin — iMessage/RCS/SMS via LINQ Partner API",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setLinqRuntime(api.runtime);
    api.registerChannel({ plugin: linqPlugin });
  },
};

export default plugin;
