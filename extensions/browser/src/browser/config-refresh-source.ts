import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";

export function loadBrowserConfigForRuntimeRefresh(): OpenClawConfig {
  return getRuntimeConfigSourceSnapshot() ?? getRuntimeConfig();
}
