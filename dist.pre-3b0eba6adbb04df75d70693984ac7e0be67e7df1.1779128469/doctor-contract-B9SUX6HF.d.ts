import { i as OpenClawConfig } from "./types.openclaw-DZQrhn8E.js";
import { C as ChannelDoctorConfigMutation, q as LegacyConfigRule } from "./types.adapters-B-MZ0DI7.js";
//#region extensions/mattermost/src/doctor-contract.d.ts
declare const legacyConfigRules: LegacyConfigRule[];
declare const normalizeCompatibilityConfig: (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorConfigMutation;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };