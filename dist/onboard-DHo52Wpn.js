import { n as applyAgentDefaultModelPrimary } from "./provider-onboard-MLXAQX8H.js";
//#region extensions/opencode-go/onboard.ts
const OPENCODE_GO_DEFAULT_MODEL_REF = "opencode-go/kimi-k2.6";
function applyOpencodeGoProviderConfig(cfg) {
	return cfg;
}
function applyOpencodeGoConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpencodeGoProviderConfig(cfg), OPENCODE_GO_DEFAULT_MODEL_REF);
}
//#endregion
export { applyOpencodeGoConfig as n, applyOpencodeGoProviderConfig as r, OPENCODE_GO_DEFAULT_MODEL_REF as t };
