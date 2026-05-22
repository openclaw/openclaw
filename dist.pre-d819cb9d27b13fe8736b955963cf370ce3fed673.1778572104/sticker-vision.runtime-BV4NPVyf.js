import { D as findModelInCatalog } from "./model-selection-shared-CkgNDUHT.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-ClIa0TN2.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-CdsNMKZM.js";
import "./agent-runtime-DQpj87aw.js";
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
