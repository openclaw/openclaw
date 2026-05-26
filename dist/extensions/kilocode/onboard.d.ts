import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { s as KILOCODE_DEFAULT_MODEL_REF, t as KILOCODE_BASE_URL } from "../../provider-models-CzCT-7Xn.js";

//#region extensions/kilocode/onboard.d.ts
declare function applyKilocodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyKilocodeConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { KILOCODE_BASE_URL, KILOCODE_DEFAULT_MODEL_REF, applyKilocodeConfig, applyKilocodeProviderConfig };