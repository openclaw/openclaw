import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { infoflowPlugin } from "./src/channel.js";
import { handleInfoflowWebhookRequest } from "./src/monitor.js";
import { setInfoflowRuntime } from "./src/runtime.js";

const plugin = {
  id: "infoflow",
  name: "Infoflow",
  description: "OpenClaw Infoflow channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setInfoflowRuntime(api.runtime);
    api.registerChannel({ plugin: infoflowPlugin });
    api.registerHttpHandler(handleInfoflowWebhookRequest);
  },
};

export default plugin;
