import { S as findModelInCatalog } from "./model-selection-shared-ydI43vWj.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-DXhHIora.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-Cjeym3yt.js";
import "./agent-runtime-CLe15ipX.js";
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
