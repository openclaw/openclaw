import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createStandardAcpConfigSchema } from "./src/config.js";
import { createStandardAcpService } from "./src/service.js";

const plugin = {
  id: "acp-standard",
  name: "Standard ACP Runtime",
  description: "ACP runtime backend for any standard ACP agent via JSON-RPC 2.0 over stdio.",
  configSchema: createStandardAcpConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(
      createStandardAcpService({
        pluginConfig: api.pluginConfig,
      }),
    );
  },
};

export default plugin;
