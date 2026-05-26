import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/zai/onboard.d.ts
declare const ZAI_DEFAULT_MODEL_REF = "zai/glm-5.1";
declare function applyZaiProviderConfig(cfg: OpenClawConfig, params?: {
  endpoint?: string;
  modelId?: string;
}): OpenClawConfig;
declare function applyZaiConfig(cfg: OpenClawConfig, params?: {
  endpoint?: string;
  modelId?: string;
}): OpenClawConfig;
//#endregion
export { applyZaiConfig as n, applyZaiProviderConfig as r, ZAI_DEFAULT_MODEL_REF as t };