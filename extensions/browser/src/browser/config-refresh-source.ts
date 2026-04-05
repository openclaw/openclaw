import { createConfigIO, getRuntimeConfigSnapshot, type MullusiConfig } from "../config/config.js";

export function loadBrowserConfigForRuntimeRefresh(): MullusiConfig {
  return getRuntimeConfigSnapshot() ?? createConfigIO().loadConfig();
}
