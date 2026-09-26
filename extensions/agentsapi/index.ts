import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAgentsApiHarness } from "./agentsapi-harness.js";

export default definePluginEntry({
  id: "agentsapi",
  name: "OpenAI Agents API",
  description: "OpenAI Agents API harness and hosted sessions.",
  register(api) {
    api.registerAgentHarness(createAgentsApiHarness(api.runtime));
  },
});
