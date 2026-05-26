import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { C as ChannelDoctorConfigMutation, T as ChannelDoctorLegacyConfigRule } from "./types.adapters-BulQCrMx.js";
//#region extensions/slack/src/doctor-contract.d.ts
declare const legacyConfigRules: ChannelDoctorLegacyConfigRule[];
declare function normalizeCompatibilityConfig({
  cfg
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation;
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };