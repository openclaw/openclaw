import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { migrateVoiceCallLegacyConfigInput } from "./src/config-migration.js";

/** Migrate voice-call plugin config inside the full OpenClaw config object. */
function migrateVoiceCallPluginConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const rawVoiceCallConfig = config.plugins?.entries?.["voice-call"]?.config;
  if (!isRecord(rawVoiceCallConfig)) {
    return null;
  }
  const migration = migrateVoiceCallLegacyConfigInput({
    value: rawVoiceCallConfig,
    configPathPrefix: "plugins.entries.voice-call.config",
  });
  if (migration.changes.length === 0) {
    return null;
  }
  const plugins = structuredClone(config.plugins ?? {});
  plugins.entries = {
    ...plugins.entries,
    "voice-call": { ...plugins.entries?.["voice-call"], config: migration.config },
  };
  return {
    config: {
      ...config,
      plugins,
    },
    changes: migration.changes,
  };
}

/** Setup plugin entry that registers voice-call config migrations. */
export default definePluginEntry({
  id: "voice-call",
  name: "Voice Call Setup",
  description: "Lightweight Voice Call setup hooks",
  register(api) {
    api.registerConfigMigration(migrateVoiceCallPluginConfig);
  },
});
