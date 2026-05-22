import { n as resolveAgentModelPrimaryValue } from "./model-input-DmUH8dul.js";
import { n as applyAgentDefaultModelPrimary } from "./provider-onboard-SezCNVus.js";
import { t as OPENCODE_GO_DEFAULT_MODEL_REF } from "./onboard-DetS-3c8.js";
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
