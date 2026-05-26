import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/plugins/enable.d.ts
type PluginEnableResult = {
  config: OpenClawConfig;
  enabled: boolean;
  pluginId: string;
  reason?: string;
};
declare function enablePluginInConfig(cfg: OpenClawConfig, pluginId: string, options?: {
  updateChannelConfig?: boolean;
}): PluginEnableResult;
//#endregion
export { enablePluginInConfig as t };