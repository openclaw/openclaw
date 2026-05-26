import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/huggingface/onboard.d.ts
declare const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";
declare function applyHuggingfaceConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyHuggingfaceConfig as n, HUGGINGFACE_DEFAULT_MODEL_REF as t };