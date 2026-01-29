import type { DNAPluginApi } from "dna/plugin-sdk";
import { emptyPluginConfigSchema } from "dna/plugin-sdk";

import { createDiagnosticsOtelService } from "./src/service.js";

const plugin = {
  id: "diagnostics-otel",
  name: "Diagnostics OpenTelemetry",
  description: "Export diagnostics events to OpenTelemetry",
  configSchema: emptyPluginConfigSchema(),
  register(api: DNAPluginApi) {
    api.registerService(createDiagnosticsOtelService());
  },
};

export default plugin;
