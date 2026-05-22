import { C as findModelInCatalog } from "./model-selection-shared-DNNsssL9.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-KwD0KwGN.js";
import { i as modelSupportsVision, n as loadModelCatalog } from "./model-catalog-BjnxngjY.js";
import "./agent-runtime-BGHDCLMX.js";
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
