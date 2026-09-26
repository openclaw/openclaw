/**
 * Browser runtime config refresh source.
 *
 * Loads the source-backed runtime config snapshot when available so long-lived
 * browser routes can refresh from disk without changing config ownership.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";

/** Load the best available config object for browser route runtime refresh. */
export function loadBrowserConfigForRuntimeRefresh(): OpenClawConfig {
  return getRuntimeConfigSourceSnapshot() ?? getRuntimeConfig();
}
