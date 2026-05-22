import { _ as findModelInCatalog } from "./model-selection-shared-HUsqLCFt.js";
import { o as resolveDefaultModelForAgent } from "./model-selection-DqTgZ6sy.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-BJ0-BpCv.js";
import "./agent-runtime-qMp10Usv.js";
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
