import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { loadGuidance } from "./src/guidance.js";

export default definePluginEntry({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api) {
    // Load the complete snapshot before registering any prompt contribution.
    const handler = loadGuidance(api.pluginConfig);
    api.on("before_prompt_build", handler);
  },
});
