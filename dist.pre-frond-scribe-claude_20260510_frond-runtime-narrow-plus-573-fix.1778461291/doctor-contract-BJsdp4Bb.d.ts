import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { C as ChannelDoctorConfigMutation, q as LegacyConfigRule } from "./types.adapters-BXDcCWqd.js";
//#region extensions/mattermost/src/doctor-contract.d.ts
declare const legacyConfigRules: LegacyConfigRule[];
declare const normalizeCompatibilityConfig: (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorConfigMutation;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };