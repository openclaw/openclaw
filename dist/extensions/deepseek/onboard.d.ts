import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
//#region extensions/deepseek/onboard.d.ts
declare const DEEPSEEK_DEFAULT_MODEL_REF = "deepseek/deepseek-v4-flash";
declare function applyDeepSeekConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { DEEPSEEK_DEFAULT_MODEL_REF, applyDeepSeekConfig };