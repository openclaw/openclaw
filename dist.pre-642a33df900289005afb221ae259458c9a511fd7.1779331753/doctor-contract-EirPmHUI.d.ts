import { i as OpenClawConfig } from "./types.openclaw-GamulG8g.js";
import { C as ChannelDoctorConfigMutation, q as LegacyConfigRule } from "./types.adapters-DJs2Vn2k.js";
//#region extensions/mattermost/src/doctor-contract.d.ts
declare const legacyConfigRules: LegacyConfigRule[];
declare const normalizeCompatibilityConfig: (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorConfigMutation;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };