import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/moonshot/onboard.d.ts
declare const MOONSHOT_DEFAULT_MODEL_REF = "moonshot/kimi-k2.6";
declare function applyMoonshotConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyMoonshotConfigCn(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyMoonshotConfig as n, applyMoonshotConfigCn as r, MOONSHOT_DEFAULT_MODEL_REF as t };