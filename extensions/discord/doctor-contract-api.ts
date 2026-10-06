import path from "node:path";
import {
  definePluginDoctorMigrationFromPlans,
  defineRetiredPluginStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { detectDiscordCommandDeployCacheMigration } from "./src/monitor/command-deploy-migration.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./config-doctor-api.js";

export const stateMigrations = [
  defineRetiredPluginStateMigration({
    id: "discord-retired-state",
    label: "Discord retired model preferences and thread bindings",
    intermediateVersion: "2026.9.5",
    findSources: ({ stateDir }) => [
      path.join(stateDir, "discord", "model-picker-preferences.json"),
      path.join(stateDir, "discord", "thread-bindings.json"),
    ],
  }),
  definePluginDoctorMigrationFromPlans({
    id: "discord-legacy-state",
    label: "Discord command deployment cache",
    resolvePlans: detectDiscordCommandDeployCacheMigration,
  }),
];
