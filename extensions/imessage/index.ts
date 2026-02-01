import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { imessagePlugin } from "./src/channel.js";
import { setIMessageRuntime } from "./src/runtime.js";

const plugin = {
  id: "imessage",
  name: "iMessage",
  description: "iMessage channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setIMessageRuntime(api.runtime);
    api.registerChannel({ plugin: imessagePlugin });
  },
};

export default plugin;
