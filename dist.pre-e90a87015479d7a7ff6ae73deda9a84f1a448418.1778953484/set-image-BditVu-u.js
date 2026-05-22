import { i as resolveAgentModelPrimaryValue } from "./model-input-B9p-bobB.js";
import { n as logConfigUpdated } from "./logging-yyhDNrSr.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-XhU0ktTD.js";
//#region src/commands/models/set-image.ts
async function modelsSetImageCommand(modelRaw, runtime) {
	const updated = await updateConfig((cfg) => {
		return applyDefaultModelPrimaryUpdate({
			cfg,
			modelRaw,
			field: "imageModel"
		});
	});
	logConfigUpdated(runtime);
	runtime.log(`Image model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.imageModel) ?? modelRaw}`);
}
//#endregion
export { modelsSetImageCommand };
