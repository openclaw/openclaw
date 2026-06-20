// Memory Core setup hooks register compatibility migration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { migrateMemoryCoreLegacyConfig } from "./src/config-compat.js";

export default definePluginEntry({
  id: "memory-core",
  name: "Memory Core Setup",
  description: "Memory Core compatibility migration hooks",
  register(api) {
    api.registerConfigMigration((config) => migrateMemoryCoreLegacyConfig(config));
  },
});
