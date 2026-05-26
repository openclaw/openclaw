import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
//#region extensions/vydra/onboard.d.ts
declare const VYDRA_DEFAULT_IMAGE_MODEL_REF = "vydra/grok-imagine";
declare function applyVydraConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { VYDRA_DEFAULT_IMAGE_MODEL_REF, applyVydraConfig };