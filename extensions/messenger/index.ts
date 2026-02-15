import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { messengerPlugin } from "./src/channel.js";
import { setMessengerRuntime } from "./src/runtime.js";

const plugin = {
  id: "messenger",
  name: "Messenger",
  description: "Facebook Messenger channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMessengerRuntime(api.runtime);
    api.registerChannel({ plugin: messengerPlugin });
  },
};

export default plugin;
