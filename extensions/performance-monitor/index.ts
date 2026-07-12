// Performance Monitor plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPerformanceMonitorService } from "./src/service.js";

export default definePluginEntry({
  id: "performance-monitor",
  name: "Performance Monitor",
  description: "Tracks per-plugin hook handler, tool, and LLM call timing via core diagnostics.",
  register(api) {
    const exporter = createPerformanceMonitorService(api.pluginConfig);
    api.registerService(exporter.service);
    api.registerHttpRoute({
      path: "/api/performance-monitor",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: exporter.handler,
    });
  },
});
