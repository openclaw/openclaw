import { i as resolveAgentModelPrimaryValue } from "./model-input-BqhOvepS.js";
import { n as applyAgentDefaultModelPrimary } from "./provider-onboard-Dax6W02v.js";
import { t as OPENCODE_GO_DEFAULT_MODEL_REF } from "./onboard-CkA8sy3-.js";
//#region extensions/opencode-go/api.ts
function applyOpencodeGoModelDefault(cfg) {
	if (resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) === "opencode-go/kimi-k2.6") return {
		next: cfg,
		changed: false
	};
	return {
		next: applyAgentDefaultModelPrimary(cfg, OPENCODE_GO_DEFAULT_MODEL_REF),
		changed: true
	};
}
//#endregion
export { applyOpencodeGoModelDefault as t };
