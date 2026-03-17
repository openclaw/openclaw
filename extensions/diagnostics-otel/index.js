import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/diagnostics-otel";
import { createDiagnosticsOtelService } from "./src/service.js";
const plugin = {
  id: "diagnostics-otel",
  name: "Diagnostics OpenTelemetry",
  description: "Export diagnostics events to OpenTelemetry",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerService(createDiagnosticsOtelService());
  }
};
var diagnostics_otel_default = plugin;
export {
  diagnostics_otel_default as default
};
