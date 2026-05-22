import { D as findModelInCatalog } from "./model-selection-shared-Cg9vhmE4.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-OBfqg2ku.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-Ckh9dF4z.js";
import "./agent-runtime-C8nZmEo_.js";
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
