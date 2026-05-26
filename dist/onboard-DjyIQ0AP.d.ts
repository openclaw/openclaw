import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/xai/onboard.d.ts
declare const XAI_DEFAULT_MODEL_REF = "xai/grok-4.3";
declare function applyXaiProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyXaiConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyXaiConfig as n, applyXaiProviderConfig as r, XAI_DEFAULT_MODEL_REF as t };