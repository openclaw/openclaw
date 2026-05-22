import { i as buildModelAliasIndex } from "./model-selection-shared-DvIdVzM0.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-CtlJEyaP.js";
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
