import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCopilotSdkAgentHarness } from "./harness.js";

export default definePluginEntry({
  id: "copilot-sdk",
  name: "GitHub Copilot SDK",
  description: "Register the placeholder GitHub Copilot SDK agent harness.",
  register(api) {
    api.registerAgentHarness(createCopilotSdkAgentHarness({ pluginConfig: api.pluginConfig }));
  },
});
