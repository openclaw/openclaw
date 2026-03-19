import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createDiagnosticsSentryService, parseDiagnosticsSentryConfig } from "./src/service.js";

export default definePluginEntry({
  id: "diagnostics-sentry",
  name: "Diagnostics Sentry",
  description: "Report cron failures to Sentry",
  register(api) {
    api.registerService(
      createDiagnosticsSentryService(parseDiagnosticsSentryConfig(api.pluginConfig)),
    );
  },
});
