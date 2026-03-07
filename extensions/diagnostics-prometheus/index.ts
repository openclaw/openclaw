import type { OpenClawPluginApi } from "openclaw/plugin-sdk/diagnostics-otel";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/diagnostics-otel";
import { createPrometheusService } from "./src/service.js";

const service = createPrometheusService();

const plugin = {
  id: "diagnostics-prometheus",
  name: "Diagnostics Prometheus",
  description: "Expose Prometheus /metrics endpoint and push metrics via Remote Write protocol",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // Register the background service (starts collectors and remote write clients)
    api.registerService(service);

    // Register /metrics HTTP pull endpoint
    api.registerHttpRoute({
      path: "/metrics",
      auth: "plugin",
      match: "exact",
      handler: async (_req, res) => {
        const exports = service.getExports();
        if (!exports?.registry) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("Prometheus metrics not initialized\n");
          return true;
        }
        try {
          const metricsText = await exports.registry.metrics();
          res.writeHead(200, { "Content-Type": exports.registry.contentType });
          res.end(metricsText);
        } catch {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Failed to collect metrics\n");
        }
        return true;
      },
    });
  },
};

export default plugin;
