import path from "node:path";
import { defineRetiredPluginStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";

export const stateMigrations = [
  defineRetiredPluginStateMigration({
    id: "imessage-retired-state",
    label: "iMessage retired monitor state",
    intermediateVersion: "2026.9.5",
    findSources: ({ stateDir }) => [
      path.join(stateDir, "imessage", "reply-cache.jsonl"),
      path.join(stateDir, "imessage", "sent-echoes.jsonl"),
      { directory: path.join(stateDir, "imessage", "catchup"), suffix: ".json" },
    ],
  }),
];
