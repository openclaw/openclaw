import { C as findModelInCatalog } from "./model-selection-shared-Bd49BLni.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-DZrSRKB-.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-CAIYwyOS.js";
import "./agent-runtime-C03cRAc6.js";
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
