import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/cerebras/onboard.d.ts
declare const CEREBRAS_DEFAULT_MODEL_REF = "cerebras/zai-glm-4.7";
declare function applyCerebrasConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyCerebrasConfig as n, CEREBRAS_DEFAULT_MODEL_REF as t };