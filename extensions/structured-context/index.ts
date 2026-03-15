import type { OpenClawPluginApi } from "openclaw/plugin-sdk/structured-context";
import {
  createStructuredContextConfigSchema,
  resolveStructuredContextConfig,
} from "./src/config.js";
import { createLayer0ContextEngine } from "./src/context-engine.js";

const structuredContextPlugin = {
  id: "structured-context",
  name: "Structured Context",
  description: "Layer0 context-engine plugin with structured compaction and continuity hints",
  kind: "context-engine",
  configSchema: createStructuredContextConfigSchema(),
  register(api: OpenClawPluginApi) {
    const config = resolveStructuredContextConfig(api.pluginConfig);
    api.registerContextEngine("structured-context", () => createLayer0ContextEngine({ config }));
  },
};

export default structuredContextPlugin;
