import { s as resolveDefaultModelForAgent } from "./model-selection-VRXWv5rs.js";
import { n as resolveCodexNativeWebSearchConfig } from "./codex-native-web-search.shared-C3S6VOBC.js";
import { n as hasAvailableCodexAuth, r as isCodexNativeSearchEligibleModel } from "./codex-native-web-search-core-CGz7P14C.js";
//#region src/agents/codex-native-web-search.ts
function isCodexNativeWebSearchRelevant(params) {
	if (resolveCodexNativeWebSearchConfig(params.config).enabled) return true;
	if (hasAvailableCodexAuth(params)) return true;
	const defaultModel = resolveDefaultModelForAgent({
		cfg: params.config,
		agentId: params.agentId
	});
	const configuredProvider = params.config.models?.providers?.[defaultModel.provider];
	const configuredModelApi = configuredProvider?.models?.find((candidate) => candidate.id === defaultModel.model)?.api;
	return isCodexNativeSearchEligibleModel({
		modelProvider: defaultModel.provider,
		modelApi: configuredModelApi ?? configuredProvider?.api
	});
}
//#endregion
export { isCodexNativeWebSearchRelevant as t };
