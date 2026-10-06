import path from "node:path";
import { defineRetiredPluginStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveVoiceCallStorePath } from "./src/store-path.js";

export const packageName = "@openclaw/voice-call";
export const stateMigrations = [
  defineRetiredPluginStateMigration({
    id: "voice-call-calls-jsonl-to-plugin-state",
    label: "Voice Call JSONL call log",
    intermediateVersion: "2026.9.7",
    findSources: (input) => [path.join(resolveVoiceCallStorePath(input), "calls.jsonl")],
  }),
];
