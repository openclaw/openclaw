import { i as resolveAgentModelPrimaryValue } from "./model-input-O00I3vtj.js";
import { r as logConfigUpdated } from "./logging-8DG0NxQz.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-CXtaMT0v.js";
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
