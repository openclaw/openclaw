import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildProdiaImageGenerationProvider } from "./image-generation-provider.js";
import { buildProdiaVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "prodia",
  name: "Prodia Provider",
  description: "Bundled Prodia image and video provider plugin",
  register(api) {
    api.registerImageGenerationProvider(buildProdiaImageGenerationProvider());
    api.registerVideoGenerationProvider(buildProdiaVideoGenerationProvider());
  },
});
