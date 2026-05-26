import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/xiaomi/onboard.d.ts
declare const XIAOMI_DEFAULT_MODEL_REF = "xiaomi/mimo-v2-flash";
declare function applyXiaomiProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyXiaomiConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyXiaomiConfig as n, applyXiaomiProviderConfig as r, XIAOMI_DEFAULT_MODEL_REF as t };