import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
//#region src/config/logging.d.ts
type LogConfigUpdatedOptions = {
  path?: string;
  backupPath?: string | false;
  suffix?: string;
};
declare function logConfigUpdated(runtime: RuntimeEnv, opts?: LogConfigUpdatedOptions): void;
//#endregion
//#region src/commands/models/shared.d.ts
type UpdateConfigContext = {
  runtimeConfig: OpenClawConfig;
};
declare function updateConfig(mutator: (cfg: OpenClawConfig, context: UpdateConfigContext) => OpenClawConfig): Promise<OpenClawConfig>;
//#endregion
export { logConfigUpdated as n, updateConfig as t };