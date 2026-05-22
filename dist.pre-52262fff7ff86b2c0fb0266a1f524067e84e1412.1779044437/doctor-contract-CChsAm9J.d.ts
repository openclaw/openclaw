import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { T as ChannelDoctorLegacyConfigRule, q as LegacyConfigRule } from "./types.adapters-Dnufj_vp.js";
//#region extensions/elevenlabs/doctor-contract.d.ts
declare function hasLegacyTalkFields(value: unknown): boolean;
declare const legacyConfigRules: ChannelDoctorLegacyConfigRule[];
declare const ELEVENLABS_TALK_LEGACY_CONFIG_RULES: LegacyConfigRule[];
declare function normalizeCompatibilityConfig({
  cfg
}: {
  cfg: OpenClawConfig;
}): {
  config: OpenClawConfig;
  changes: string[];
};
//#endregion
export { normalizeCompatibilityConfig as i, hasLegacyTalkFields as n, legacyConfigRules as r, ELEVENLABS_TALK_LEGACY_CONFIG_RULES as t };