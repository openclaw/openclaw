import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/qianfan/onboard.d.ts
declare const QIANFAN_DEFAULT_MODEL_REF = "qianfan/deepseek-v3.2";
declare function applyQianfanProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyQianfanConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyQianfanConfig as n, applyQianfanProviderConfig as r, QIANFAN_DEFAULT_MODEL_REF as t };