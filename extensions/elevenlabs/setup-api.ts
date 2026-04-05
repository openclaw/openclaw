import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { migrateElevenLabsLegacyTalkConfig } from "./config-compat.js";

export default definePluginEntry({
  id: "elevenlabs",
  name: "ElevenLabs Setup",
  description: "Lightweight ElevenLabs setup hooks",
  register(api) {
    api.registerLegacyConfigMigration((raw, changes) => {
      const migrated = migrateElevenLabsLegacyTalkConfig(raw);
      if (migrated.changes.length === 0) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      Object.assign(raw, migrated.config);
      changes.push(...migrated.changes);
    });
  },
});
