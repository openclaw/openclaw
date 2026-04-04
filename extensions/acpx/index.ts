import type { OpenClawPluginApi } from "./runtime-api.js";
import { createAcpxPluginConfigSchema } from "./src/config-schema.js";

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "ACP runtime backend powered by the acpx CLI.",
  configSchema: () => createAcpxPluginConfigSchema(),
  async register(api: OpenClawPluginApi) {
    const { createAcpxRuntimeService } = await import("./register.runtime.js");
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
  },
};

export default plugin;
