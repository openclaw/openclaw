import { i as buildModelAliasIndex } from "./model-selection-shared-BCJZ6pnb.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-B80gzYOd.js";
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
