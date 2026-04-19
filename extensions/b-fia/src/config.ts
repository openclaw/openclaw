/**
 * Configuration resolution for B-FIA backend connection.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

const DEFAULT_BACKEND_URL = "http://localhost:8321";

export function resolveBackendUrl(cfg?: OpenClawConfig): string {
  // 1. Check plugin config
  const pluginConfig = cfg?.plugins?.entries?.["b-fia"]?.config;
  if (pluginConfig?.backendUrl && typeof pluginConfig.backendUrl === "string") {
    return pluginConfig.backendUrl.replace(/\/$/, "");
  }

  // 2. Check environment variable
  const envUrl = process.env.BFIA_BACKEND_URL;
  if (envUrl) {
    return envUrl.replace(/\/$/, "");
  }

  return DEFAULT_BACKEND_URL;
}
