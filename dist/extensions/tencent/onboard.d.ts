import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
//#region extensions/tencent/onboard.d.ts
declare const TOKENHUB_DEFAULT_MODEL_REF = "tencent-tokenhub/hy3-preview";
declare function applyTokenHubConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { TOKENHUB_DEFAULT_MODEL_REF, applyTokenHubConfig };