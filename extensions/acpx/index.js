import { createAcpxPluginConfigSchema } from "./src/config.js";
import { createAcpxRuntimeService } from "./src/service.js";
const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "ACP runtime backend powered by the acpx CLI.",
  configSchema: createAcpxPluginConfigSchema(),
  register(api) {
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig
      })
    );
  }
};
var acpx_default = plugin;
export {
  acpx_default as default
};
