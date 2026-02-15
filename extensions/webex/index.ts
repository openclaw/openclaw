import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { setWebexRuntime } from "./src/runtime.js";
import { webexPlugin } from "./src/channel.js";
import { handleWebexWebhookRequest } from "./src/monitor.js";

const plugin = {
  id: "webex",
  name: "Webex",
  description: "Cisco Webex channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWebexRuntime(api.runtime);
    api.registerChannel({ plugin: webexPlugin });
    api.registerHttpHandler(handleWebexWebhookRequest);
  },
};

export default plugin;
