import { i as OpenClawConfig } from "./types.openclaw-CQzDxdpQ.js";
import { C as ChannelDoctorConfigMutation, q as LegacyConfigRule } from "./types.adapters-r3TJy9mk.js";
//#region extensions/mattermost/src/doctor-contract.d.ts
declare const legacyConfigRules: LegacyConfigRule[];
declare const normalizeCompatibilityConfig: (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorConfigMutation;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };