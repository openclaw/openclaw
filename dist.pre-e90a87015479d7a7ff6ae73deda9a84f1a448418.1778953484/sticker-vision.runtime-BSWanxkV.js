import { D as findModelInCatalog } from "./model-selection-shared-DvIdVzM0.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-CtlJEyaP.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-BKZVkuD4.js";
import "./agent-runtime-D8uLumig.js";
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
