import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { n as RuntimeEnv } from "./runtime-D0p4Vp8x.js";
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