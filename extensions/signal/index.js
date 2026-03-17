import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/signal";
import { signalPlugin } from "./src/channel.js";
import { setSignalRuntime } from "./src/runtime.js";
const plugin = {
  id: "signal",
  name: "Signal",
  description: "Signal channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setSignalRuntime(api.runtime);
    api.registerChannel({ plugin: signalPlugin });
  }
};
var signal_default = plugin;
export {
  signal_default as default
};
