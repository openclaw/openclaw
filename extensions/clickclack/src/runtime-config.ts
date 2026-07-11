/** Selects the active runtime config when the caller still holds the persisted source config. */
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { CoreConfig } from "./types.js";

export function selectClickClackRuntimeConfig(inputConfig: CoreConfig): CoreConfig {
  return (selectApplicableRuntimeConfig({
    inputConfig,
    runtimeConfig: getRuntimeConfigSnapshot(),
    runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
  }) ?? inputConfig) as CoreConfig;
}
