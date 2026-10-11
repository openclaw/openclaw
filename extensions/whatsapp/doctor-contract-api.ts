import { whatsappLegacyStateMigration } from "./src/state-migrations.js";

export { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";

export const stateMigrations = [whatsappLegacyStateMigration];
