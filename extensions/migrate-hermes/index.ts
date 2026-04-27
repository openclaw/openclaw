import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildHermesMigrationProvider } from "./provider.js";

export default definePluginEntry({
  id: "hermes-migration",
  name: "Hermes Migration",
  description: "Imports Hermes state into OpenClaw.",
  register(api) {
    api.registerMigrationProvider(buildHermesMigrationProvider({ runtime: api.runtime }));
  },
});
