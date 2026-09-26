import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./config-doctor-api.js";

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "telegram-legacy-state",
    label: "Retired Telegram JSON state",
    async detectLegacyState(params) {
      const { telegramRetiredStateMigration } = await import("./src/state-migrations.js");
      return telegramRetiredStateMigration.detectLegacyState(params);
    },
    async migrateLegacyState(params) {
      const { telegramRetiredStateMigration } = await import("./src/state-migrations.js");
      return telegramRetiredStateMigration.migrateLegacyState(params);
    },
  },
];
