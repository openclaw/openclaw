import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAgentsApiHarness } from "./agentsapi-harness.js";
import { agentsApiConfigSchema } from "./config.js";

export default definePluginEntry({
  id: "agentsapi",
  name: "OpenAI Agents API",
  description: "OpenAI Agents API harness with hosted or self-hosted sessions.",
  configSchema: buildPluginConfigSchema(agentsApiConfigSchema),
  register(api) {
    api.registerAgentHarness(createAgentsApiHarness(api.runtime));
  },
});
