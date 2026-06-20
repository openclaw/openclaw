// Memory Wiki setup hooks register compatibility migration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { migrateMemoryWikiLegacyConfig } from "./src/config-compat.js";

export default definePluginEntry({
  id: "memory-wiki",
  name: "Memory Wiki Setup",
  description: "Memory Wiki compatibility migration hooks",
  register(api) {
    api.registerConfigMigration((config) => migrateMemoryWikiLegacyConfig(config));
  },
});
