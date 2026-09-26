import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "imessage-legacy-state",
    label: "iMessage legacy state",
    async detectLegacyState(params) {
      const { imessageRetiredStateMigration } = await import("./src/state-migrations.js");
      return imessageRetiredStateMigration.detectLegacyState(params);
    },
    async migrateLegacyState(params) {
      const { imessageRetiredStateMigration } = await import("./src/state-migrations.js");
      return imessageRetiredStateMigration.migrateLegacyState(params);
    },
  },
];
