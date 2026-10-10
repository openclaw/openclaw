import path from "node:path";
import { defineRetiredPluginStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export const stateMigrations = [
  defineRetiredPluginStateMigration({
    id: "device-pair-retired-state",
    label: "Device Pair retired notify state",
    intermediateVersion: "2026.9.5",
    findSources: ({ stateDir }) => [path.join(stateDir, "device-pair-notify.json")],
  }),
];
