import { i as resolveAgentModelPrimaryValue } from "./model-input-B9p-bobB.js";
import { r as logConfigUpdated } from "./logging-DZvLiFyY.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-BhMXO46G.js";
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
