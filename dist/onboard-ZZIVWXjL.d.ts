import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/opencode/onboard.d.ts
declare const OPENCODE_ZEN_DEFAULT_MODEL_REF = "opencode/claude-opus-4-6";
declare function applyOpencodeZenProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyOpencodeZenConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyOpencodeZenConfig as n, applyOpencodeZenProviderConfig as r, OPENCODE_ZEN_DEFAULT_MODEL_REF as t };