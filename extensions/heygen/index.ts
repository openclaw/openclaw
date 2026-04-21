import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildHeygenVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "heygen",
  name: "HeyGen Provider",
  description: "HeyGen avatar video provider (identity-first, agent-native)",
  register(api) {
    api.registerVideoGenerationProvider(buildHeygenVideoGenerationProvider());
  },
});
