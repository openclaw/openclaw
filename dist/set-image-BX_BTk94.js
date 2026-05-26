import { i as resolveAgentModelPrimaryValue } from "./model-input-ChW9XXsQ.js";
import { r as logConfigUpdated } from "./logging-t-RUPR6R.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-CXerptPG.js";
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
