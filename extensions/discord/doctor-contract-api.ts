import { discordLegacyStateMigration } from "./src/monitor/model-picker-preferences-migrations.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./config-doctor-api.js";

export const stateMigrations = [discordLegacyStateMigration];
