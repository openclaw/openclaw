import { C as findModelInCatalog } from "./model-selection-shared-fWnBOAl-.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-BGs61_ek.js";
import { i as modelSupportsVision, n as loadModelCatalog } from "./model-catalog-DacZz4fu.js";
import "./agent-runtime-Dzzt187S.js";
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
