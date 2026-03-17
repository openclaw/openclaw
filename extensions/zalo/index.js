import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/zalo";
import { zaloDock, zaloPlugin } from "./src/channel.js";
import { setZaloRuntime } from "./src/runtime.js";
const plugin = {
  id: "zalo",
  name: "Zalo",
  description: "Zalo channel plugin (Bot API)",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setZaloRuntime(api.runtime);
    api.registerChannel({ plugin: zaloPlugin, dock: zaloDock });
  }
};
var zalo_default = plugin;
export {
  zalo_default as default
};
