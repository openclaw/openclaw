import { _ as findModelInCatalog } from "./model-selection-shared-BBpFqu68.js";
import { o as resolveDefaultModelForAgent } from "./model-selection-BP-YASdB.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-D3O5e8PY.js";
import "./agent-runtime-Bw1oNb-Q.js";
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
