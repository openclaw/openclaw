import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
import { C as ChannelDoctorConfigMutation, q as LegacyConfigRule } from "./types.adapters-Dn-4HpCW.js";
//#region extensions/mattermost/src/doctor-contract.d.ts
declare const legacyConfigRules: LegacyConfigRule[];
declare const normalizeCompatibilityConfig: (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorConfigMutation;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };