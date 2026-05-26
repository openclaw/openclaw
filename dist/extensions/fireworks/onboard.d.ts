import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
//#region extensions/fireworks/onboard.d.ts
declare const FIREWORKS_DEFAULT_MODEL_REF = "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo";
declare function applyFireworksConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { FIREWORKS_DEFAULT_MODEL_REF, applyFireworksConfig };