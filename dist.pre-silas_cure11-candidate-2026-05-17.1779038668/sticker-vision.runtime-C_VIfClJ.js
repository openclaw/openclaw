import { C as findModelInCatalog } from "./model-selection-shared-D-NMyYXW.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-T92uY7wQ.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-D9WmDtLe.js";
import "./agent-runtime-5IaGF7KT.js";
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
