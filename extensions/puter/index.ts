import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPuterProvider } from "./provider.js";

export default definePluginEntry({
  id: "puter",
  name: "Puter Provider",
  description: "Bundled Puter provider plugin",
  register(api) {
    api.registerProvider(buildPuterProvider());
  },
});
