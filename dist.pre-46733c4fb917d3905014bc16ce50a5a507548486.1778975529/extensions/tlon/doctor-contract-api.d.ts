import { i as OpenClawConfig } from "../../types.openclaw-C5VNg6h3.js";
import { C as ChannelDoctorConfigMutation, q as LegacyConfigRule } from "../../types.adapters-gJ2yXQSn.js";
//#region extensions/tlon/src/doctor-contract.d.ts
declare const legacyConfigRules: LegacyConfigRule[];
declare const normalizeCompatibilityConfig: (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorConfigMutation;
//#endregion
export { legacyConfigRules, normalizeCompatibilityConfig };