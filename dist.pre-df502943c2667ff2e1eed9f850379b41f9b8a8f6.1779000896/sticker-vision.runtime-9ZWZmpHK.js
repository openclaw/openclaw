import { C as findModelInCatalog } from "./model-selection-shared-D-NMyYXW.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-Co5pqKAn.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-BWQ8opyK.js";
import "./agent-runtime-CkaUIxs9.js";
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
