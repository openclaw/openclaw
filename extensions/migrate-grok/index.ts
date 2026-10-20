import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildGrokMigrationProvider } from "./provider.js";

export default definePluginEntry({
  id: "migrate-grok",
  name: "Grok Bot Migration",
  description: "Imports Grok Bot configuration into OpenClaw.",
  register(api) {
    api.registerMigrationProvider(buildGrokMigrationProvider({ runtime: api.runtime }));
  },
});
