import type { OpenClawPluginApi } from "openclaw/plugin-sdk/diagnostics-otel";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/diagnostics-otel";
import { createDiagnosticsOtelService } from "./src/service.js";

const plugin = {
  id: "diagnostics-otel",
  name: "Diagnostics OpenTelemetry",
  description: "Export diagnostics events to OpenTelemetry",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(createDiagnosticsOtelService());
  },
};

export default plugin;
