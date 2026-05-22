import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { C as ChannelDoctorConfigMutation, T as ChannelDoctorLegacyConfigRule } from "../../types.adapters-BXDcCWqd.js";
//#region extensions/whatsapp/src/doctor-contract.d.ts
declare function normalizeCompatibilityConfig({
  cfg
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation;
//#endregion
//#region extensions/whatsapp/doctor-contract-api.d.ts
declare const legacyConfigRules: ChannelDoctorLegacyConfigRule[];
//#endregion
export { legacyConfigRules, normalizeCompatibilityConfig };