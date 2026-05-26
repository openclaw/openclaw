import { C as findModelInCatalog } from "./model-selection-shared-ClxdEp4X.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { i as modelSupportsVision, n as loadModelCatalog } from "./model-catalog-DhWpNp70.js";
import "./agent-runtime-Lc7H-PlR.js";
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
