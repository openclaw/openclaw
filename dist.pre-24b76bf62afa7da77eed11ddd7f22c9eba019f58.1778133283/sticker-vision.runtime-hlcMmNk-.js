import { _ as findModelInCatalog } from "./model-selection-shared-nVmByRp_.js";
import { o as resolveDefaultModelForAgent } from "./model-selection-BWQiz_aq.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-CsooIxjE.js";
import "./agent-runtime-Df1vJZj4.js";
//#region extensions/telegram/src/sticker-vision.runtime.ts
async function resolveStickerVisionSupportRuntime(params) {
	const catalog = await loadModelCatalog({ config: params.cfg });
	const defaultModel = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
	if (!entry) return false;
	return modelSupportsVision(entry);
}
//#endregion
export { resolveStickerVisionSupportRuntime };
