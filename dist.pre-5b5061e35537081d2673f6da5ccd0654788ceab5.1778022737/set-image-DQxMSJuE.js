import { n as resolveAgentModelPrimaryValue } from "./model-input-DVA3X1TY.js";
import { n as logConfigUpdated } from "./logging-C9iUgLGX.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-BjZZSoRb.js";
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
