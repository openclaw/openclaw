import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/mistral/onboard.d.ts
declare const MISTRAL_DEFAULT_MODEL_REF = "mistral/mistral-large-latest";
declare function applyMistralProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyMistralConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyMistralConfig as n, applyMistralProviderConfig as r, MISTRAL_DEFAULT_MODEL_REF as t };