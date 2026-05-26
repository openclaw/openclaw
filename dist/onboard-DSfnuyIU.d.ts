import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/chutes/onboard.d.ts
/**
 * Apply Chutes provider configuration without changing the default model.
 * Registers all catalog models and sets provider aliases (chutes-fast, etc.).
 */
declare function applyChutesProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
/**
 * Apply Chutes provider configuration AND set Chutes as the default model.
 */
declare function applyChutesConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyChutesApiKeyConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyChutesConfig as n, applyChutesProviderConfig as r, applyChutesApiKeyConfig as t };