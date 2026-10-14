import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { migrateCanvasHostConfig } from "./src/config-migration.js";

export default definePluginEntry({
  id: "canvas",
  name: "Canvas Setup",
  description: "Lightweight Canvas setup hooks",
  register(api) {
    api.registerConfigMigration(migrateCanvasHostConfig);
  },
});
