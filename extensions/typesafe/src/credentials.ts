import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { runtimeConfig, type RuntimeConfig } from "./config.js";

/** Only host-prepared capability snapshots may supply a credential. Never resolve or cache refs. */
export function resolveRuntimeConfig(
  snapshot: ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>,
): RuntimeConfig {
  const configured = snapshot.plugins?.entries?.typesafe?.config;
  const validated = runtimeConfig(configured);
  const prepared = getPreparedPluginSecretInput("typesafe", "apiKey");
  return { ...validated, apiKey: prepared.value };
}
