import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/arcee/onboard.d.ts
declare const ARCEE_DEFAULT_MODEL_REF = "arcee/trinity-large-thinking";
declare const ARCEE_OPENROUTER_DEFAULT_MODEL_REF = "arcee/trinity-large-thinking";
declare function applyArceeConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyArceeOpenRouterConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyArceeOpenRouterConfig as i, ARCEE_OPENROUTER_DEFAULT_MODEL_REF as n, applyArceeConfig as r, ARCEE_DEFAULT_MODEL_REF as t };