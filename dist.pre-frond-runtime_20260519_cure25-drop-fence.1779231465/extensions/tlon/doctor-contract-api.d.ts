import { i as OpenClawConfig } from "../../types.openclaw-CQzDxdpQ.js";
import { C as ChannelDoctorConfigMutation, q as LegacyConfigRule } from "../../types.adapters-r3TJy9mk.js";
//#region extensions/tlon/src/doctor-contract.d.ts
declare const legacyConfigRules: LegacyConfigRule[];
declare const normalizeCompatibilityConfig: (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorConfigMutation;
//#endregion
export { legacyConfigRules, normalizeCompatibilityConfig };