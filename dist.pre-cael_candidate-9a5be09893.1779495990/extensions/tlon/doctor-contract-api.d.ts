import { i as OpenClawConfig } from "../../types.openclaw-GamulG8g.js";
import { C as ChannelDoctorConfigMutation, q as LegacyConfigRule } from "../../types.adapters-DJs2Vn2k.js";
//#region extensions/tlon/src/doctor-contract.d.ts
declare const legacyConfigRules: LegacyConfigRule[];
declare const normalizeCompatibilityConfig: (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorConfigMutation;
//#endregion
export { legacyConfigRules, normalizeCompatibilityConfig };