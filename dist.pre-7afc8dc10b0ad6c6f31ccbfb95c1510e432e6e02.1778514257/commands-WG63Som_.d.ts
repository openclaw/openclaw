import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { in as NativeCommandsSetting } from "./types.channels-CZZMDOR0.js";
import { t as ChannelId } from "./channel-id.types-DZJbj8ko.js";
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