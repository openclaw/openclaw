import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/openrouter/onboard.d.ts
declare const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
declare function applyOpenrouterProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyOpenrouterConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyOpenrouterConfig as n, applyOpenrouterProviderConfig as r, OPENROUTER_DEFAULT_MODEL_REF as t };