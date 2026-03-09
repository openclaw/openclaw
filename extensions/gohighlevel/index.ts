import type { OpenClawPluginApi } from "openclaw/plugin-sdk/gohighlevel";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/gohighlevel";
import { gohighlevelDock, gohighlevelPlugin } from "./src/channel.js";
import { setGoHighLevelRuntime } from "./src/runtime.js";

const plugin = {
  id: "gohighlevel",
  name: "GoHighLevel",
  description: "OpenClaw GoHighLevel channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setGoHighLevelRuntime(api.runtime);
    api.registerChannel({ plugin: gohighlevelPlugin, dock: gohighlevelDock });
  },
};

export default plugin;
