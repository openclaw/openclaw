import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildHeyGenVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "heygen",
  name: "HeyGen Provider",
  description: "Bundled HeyGen avatar video provider plugin",
  register(api) {
    api.registerVideoGenerationProvider(buildHeyGenVideoGenerationProvider());
  },
});
