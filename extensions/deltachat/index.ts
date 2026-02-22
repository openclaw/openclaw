import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { deltachatPlugin } from "./src/channel.js";
import { setDeltaChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "deltachat",
  name: "Delta.Chat",
  description: "Delta.Chat channel plugin (end-to-end encrypted messaging)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDeltaChatRuntime(api.runtime);
    api.registerChannel({ plugin: deltachatPlugin });
  },
};

export default plugin;
