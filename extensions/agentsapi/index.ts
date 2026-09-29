import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAgentsApiHarness } from "./agentsapi-harness.js";
import { agentsApiConfigSchema } from "./config.js";

export default definePluginEntry({
  id: "agentsapi",
  name: "OpenAI Agents API",
  description: "OpenAI Agents API harness with hosted or self-hosted sessions.",
  configSchema: buildPluginConfigSchema(agentsApiConfigSchema),
  reload: {
    noopPrefixes: ["plugins.entries.agentsapi.config.plugins"],
  },
  register(api) {
    const config = agentsApiConfigSchema.parse(api.pluginConfig ?? {});
    api.registerAgentHarness(createAgentsApiHarness(api.runtime, config));
  },
});
