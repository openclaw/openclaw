import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { C as ChannelDoctorConfigMutation, q as LegacyConfigRule } from "../../types.adapters-BXDcCWqd.js";
//#region extensions/nextcloud-talk/src/doctor-contract.d.ts
declare const legacyConfigRules: LegacyConfigRule[];
declare const normalizeCompatibilityConfig: (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorConfigMutation;
//#endregion
export { legacyConfigRules, normalizeCompatibilityConfig };