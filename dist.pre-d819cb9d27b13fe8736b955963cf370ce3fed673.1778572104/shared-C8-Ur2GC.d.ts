import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { n as RuntimeEnv } from "./runtime-B7xbUSXv.js";
//#region src/config/logging.d.ts
type LogConfigUpdatedOptions = {
  path?: string;
  suffix?: string;
};
declare function logConfigUpdated(runtime: RuntimeEnv, opts?: LogConfigUpdatedOptions): void;
//#endregion
//#region src/commands/models/shared.d.ts
declare function updateConfig(mutator: (cfg: OpenClawConfig) => OpenClawConfig): Promise<OpenClawConfig>;
//#endregion
export { logConfigUpdated as n, updateConfig as t };