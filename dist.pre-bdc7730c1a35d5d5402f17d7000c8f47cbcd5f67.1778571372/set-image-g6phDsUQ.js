import { i as resolveAgentModelPrimaryValue } from "./model-input-BqhOvepS.js";
import { n as logConfigUpdated } from "./logging-BLkS6uwI.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-DKj5o1O9.js";
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
