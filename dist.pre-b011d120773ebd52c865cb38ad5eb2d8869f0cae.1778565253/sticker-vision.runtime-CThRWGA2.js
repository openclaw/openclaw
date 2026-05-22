import { D as findModelInCatalog } from "./model-selection-shared-Cz4Ee-l6.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-C3RHt1lm.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-ClJbmM2S.js";
import "./agent-runtime-DOBpu6DW.js";
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
