import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { s as KILOCODE_DEFAULT_MODEL_REF, t as KILOCODE_BASE_URL } from "../../provider-models-h8hEpluV.js";

//#region extensions/kilocode/onboard.d.ts
declare function applyKilocodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyKilocodeConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { KILOCODE_BASE_URL, KILOCODE_DEFAULT_MODEL_REF, applyKilocodeConfig, applyKilocodeProviderConfig };