import { i as resolveAgentModelPrimaryValue } from "./model-input-BqhOvepS.js";
import { n as logConfigUpdated } from "./logging-CxcH-DGa.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-B3QGREdE.js";
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
