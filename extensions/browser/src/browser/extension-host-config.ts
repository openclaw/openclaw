import { readConfigFileSnapshot } from "openclaw/plugin-sdk/health";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";

/** Standalone browser helpers must not observe, repair, or migrate Gateway state. */
export async function readBrowserHostConfig() {
  const snapshot = await readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });
  if (!snapshot.valid) {
    throw new Error("Browser host configuration is invalid");
  }
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  setRuntimeConfigSnapshot(cfg, snapshot.sourceConfig);
  return cfg;
}
