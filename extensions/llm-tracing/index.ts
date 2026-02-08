import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createLlmTracingService } from "./src/service.js";

const plugin = {
  id: "llm-tracing",
  name: "LLM Content Tracing",
  description: "Trace LLM calls with input/output content via OpenTelemetry",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // Pass api to service so it can register hooks during start()
    api.registerService(createLlmTracingService(api));
  },
};

export default plugin;
