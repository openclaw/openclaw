import { D as findModelInCatalog } from "./model-selection-shared-DEFYGBdW.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-DmMcdmk8.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-DUX-2da-.js";
import "./agent-runtime-DWKgRpfJ.js";
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
