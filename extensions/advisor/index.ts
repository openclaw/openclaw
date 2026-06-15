/**
 * Advisor plugin — model-agnostic second-opinion tool for agent sessions.
 *
 * By default uses the agent's active model. To route to a different model
 * (e.g. a local Gemma via vMLX), set in agent config:
 *
 *   plugins.entries.advisor.config.modelRef = "vmlx/gemma-4-26B"
 *   plugins.entries.advisor.llm.allowModelOverride = true
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAdvisorTool } from "./src/tool.js";

export default definePluginEntry({
  id: "advisor",
  name: "Advisor",
  description:
    "Model-agnostic advisor tool that provides expert second opinions during agent sessions using any configured LLM provider.",
  reload: {
    restartPrefixes: ["plugins.entries.advisor"],
  },
  register(api) {
    api.registerTool((ctx) => createAdvisorTool(ctx, api));
  },
});
