// Telegram API module exposes the plugin public contract.
import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./config-doctor-api.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "telegram-legacy-state",
    label: "Telegram legacy state",
    // Config repair enumerates this artifact too; load the detector only when
    // detection or migration resolves plans.
    resolvePlans: async (params) => {
      const { detectTelegramLegacyStateMigrations } = await import("./src/state-migrations.js");
      return detectTelegramLegacyStateMigrations(params);
    },
  }),
];
