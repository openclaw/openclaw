// Voice Call plugin module resolves its default persistence root.
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath } from "./utils.js";

/** Resolve the plugin-owned store below OpenClaw's canonical state directory. */
export function resolveDefaultVoiceCallStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "voice-calls");
}

/** Read the configured voice-call store path from either package id. */
function getVoiceCallConfigStore(config: OpenClawConfig): string {
  for (const pluginId of ["voice-call", "@openclaw/voice-call"]) {
    const store = asOptionalRecord(config.plugins?.entries?.[pluginId]?.config)?.store;
    if (typeof store === "string" && store.trim()) {
      return store.trim();
    }
  }
  return "";
}

/** Resolve the voice-call store path used by legacy and plugin-state call records. */
export function resolveVoiceCallStorePath(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): string {
  const configuredStore = getVoiceCallConfigStore(params.config);
  if (configuredStore) {
    return resolveUserPath(configuredStore, () => params.env.HOME?.trim() || os.homedir());
  }
  return resolveDefaultVoiceCallStoreDir(params.env);
}
