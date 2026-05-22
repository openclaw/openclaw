import { i as resolveAgentModelPrimaryValue } from "./model-input-iH6kLgu0.js";
import { n as logConfigUpdated } from "./logging-DnElYwcR.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-_xcuTrjV.js";
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
