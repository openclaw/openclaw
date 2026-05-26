import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/kimi-coding/onboard.d.ts
declare const KIMI_MODEL_REF = "kimi/kimi-for-coding";
declare const KIMI_CODING_MODEL_REF = "kimi/kimi-for-coding";
declare function applyKimiCodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyKimiCodeConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyKimiCodeProviderConfig as i, KIMI_MODEL_REF as n, applyKimiCodeConfig as r, KIMI_CODING_MODEL_REF as t };