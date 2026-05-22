import { C as findModelInCatalog } from "./model-selection-shared-C0W6f8jq.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-DCMPulC-.js";
import { i as modelSupportsVision, n as loadModelCatalog } from "./model-catalog-CKOdm8XK.js";
import "./agent-runtime-C1rdNqcV.js";
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
