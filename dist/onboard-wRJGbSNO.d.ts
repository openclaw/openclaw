import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/opencode-go/onboard.d.ts
declare const OPENCODE_GO_DEFAULT_MODEL_REF = "opencode-go/kimi-k2.6";
declare function applyOpencodeGoProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyOpencodeGoConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyOpencodeGoConfig as n, applyOpencodeGoProviderConfig as r, OPENCODE_GO_DEFAULT_MODEL_REF as t };