import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wempPlugin } from "./src/channel.js";
import { setWempRuntime } from "./src/runtime.js";
import { bindStorageRuntime } from "./src/storage.js";
import { handleRegisteredWebhookRequest } from "./src/webhook.js";

const plugin = {
  id: "wemp",
  name: "WeChat Official Account",
  description: "WeChat Official Account channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    bindStorageRuntime(api.runtime);
    setWempRuntime(api.runtime);
    api.registerChannel({ plugin: wempPlugin });
    api.registerHttpHandler(handleRegisteredWebhookRequest);
  },
};

export default plugin;
