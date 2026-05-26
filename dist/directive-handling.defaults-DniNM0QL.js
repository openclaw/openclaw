import { i as buildModelAliasIndex } from "./model-selection-shared-ClxdEp4X.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
//#region src/auto-reply/reply/directive-handling.defaults.ts
function resolveDefaultModel(params) {
	const mainModel = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	const defaultProvider = mainModel.provider;
	return {
		defaultProvider,
		defaultModel: mainModel.model,
		aliasIndex: buildModelAliasIndex({
			cfg: params.cfg,
			defaultProvider
		})
	};
}
//#endregion
export { resolveDefaultModel as t };
