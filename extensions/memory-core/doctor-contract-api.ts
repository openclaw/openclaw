import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { dreamingCronMigration } from "./src/migration/doctor-dreaming-cron.js";
import { dreamingStateMigration } from "./src/migration/doctor-dreaming-state.js";
import { hostEventsStateMigration } from "./src/migration/doctor-host-events.js";
import {
  memorySidecarStateMigration,
  qmdLocksStateMigration,
  qmdWorkspaceStateMigration,
} from "./src/migration/doctor-memory-sidecar.js";

export const stateMigrations: PluginDoctorStateMigration[] = [
  hostEventsStateMigration,
  dreamingStateMigration,
  dreamingCronMigration,
  memorySidecarStateMigration,
  qmdWorkspaceStateMigration,
  qmdLocksStateMigration,
];
