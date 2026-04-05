import type { MullusiConfig } from "mullusi/plugin-sdk/browser-support";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "mullusi/plugin-sdk/browser-support";

export function isDefaultBrowserPluginEnabled(cfg: MullusiConfig): boolean {
  return resolveEffectiveEnableState({
    id: "browser",
    origin: "bundled",
    config: normalizePluginsConfig(cfg.plugins),
    rootConfig: cfg,
    enabledByDefault: true,
  }).enabled;
}
