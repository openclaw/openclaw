import { S as findModelInCatalog } from "./model-selection-shared-B3Eh9den.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-DX8uTa0m.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-BRDjhg8Q.js";
import "./agent-runtime-ptt0k360.js";
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
