import type { EasyHubPluginApi } from "EasyHub/plugin-sdk";
import { emptyPluginConfigSchema } from "EasyHub/plugin-sdk";
import { createDiagnosticsOtelService } from "./src/service.js";

const plugin = {
  id: "diagnostics-otel",
  name: "Diagnostics OpenTelemetry",
  description: "Export diagnostics events to OpenTelemetry",
  configSchema: emptyPluginConfigSchema(),
  register(api: EasyHubPluginApi) {
    api.registerService(createDiagnosticsOtelService());
  },
};

export default plugin;
