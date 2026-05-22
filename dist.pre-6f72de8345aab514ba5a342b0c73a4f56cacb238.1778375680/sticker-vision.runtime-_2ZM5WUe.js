import { S as findModelInCatalog } from "./model-selection-shared-C1JUDoHW.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-DDEg6aT2.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-CWcd3ars.js";
import "./agent-runtime-5aHavpw2.js";
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
