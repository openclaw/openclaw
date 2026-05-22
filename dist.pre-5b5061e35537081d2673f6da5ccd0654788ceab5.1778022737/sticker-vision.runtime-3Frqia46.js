import { _ as findModelInCatalog } from "./model-selection-shared-DbwzllLp.js";
import { o as resolveDefaultModelForAgent } from "./model-selection-aDhlumjq.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-DH6dOsB0.js";
import "./agent-runtime-C_mQhM4s.js";
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
