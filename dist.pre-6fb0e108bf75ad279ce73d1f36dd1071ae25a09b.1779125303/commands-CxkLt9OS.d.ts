import { i as OpenClawConfig } from "./types.openclaw-DBDmmaVM.js";
import { sn as NativeCommandsSetting } from "./types.channels-B8PNxvXK.js";
import { t as ChannelId } from "./channel-id.types-D1ZJyHGT.js";
//#region src/config/commands.d.ts
declare function resolveNativeSkillsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  autoDefault?: boolean;
}): boolean;
declare function resolveNativeCommandsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  autoDefault?: boolean;
}): boolean;
declare function isNativeCommandsExplicitlyDisabled(params: {
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean;
//#endregion
export { resolveNativeCommandsEnabled as n, resolveNativeSkillsEnabled as r, isNativeCommandsExplicitlyDisabled as t };