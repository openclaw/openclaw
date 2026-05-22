import { n as resolveAgentModelPrimaryValue } from "./model-input-qoijZF3K.js";
import { n as logConfigUpdated } from "./logging-Cds-1VVS.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-CDB1vyks.js";
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
