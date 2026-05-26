import { i as OpenClawConfig } from "../../types.openclaw-DIZy8jcb.js";
import { n as applyOpencodeGoConfig, r as applyOpencodeGoProviderConfig, t as OPENCODE_GO_DEFAULT_MODEL_REF } from "../../onboard-GSiVdaWX.js";

//#region extensions/opencode-go/api.d.ts
declare function applyOpencodeGoModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
};
//#endregion
export { OPENCODE_GO_DEFAULT_MODEL_REF, applyOpencodeGoConfig, applyOpencodeGoModelDefault, applyOpencodeGoProviderConfig };