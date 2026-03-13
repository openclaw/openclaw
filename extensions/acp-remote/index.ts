import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acp";
import { createAcpRemotePluginConfigSchema } from "./src/config.js";
import { createAcpRemoteRuntimeService } from "./src/service.js";

const plugin = {
  id: "acp-remote",
  name: "ACP Remote Runtime",
  description: "ACP runtime backend powered by a remote HTTP gateway.",
  configSchema: createAcpRemotePluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(
      createAcpRemoteRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
  },
};

export default plugin;
