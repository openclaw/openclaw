import { n as resolveAgentModelPrimaryValue } from "./model-input-qoijZF3K.js";
import { n as logConfigUpdated } from "./logging-Cds-1VVS.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-CDB1vyks.js";
//#region src/commands/models/set.ts
async function modelsSetCommand(modelRaw, runtime) {
	const updated = await updateConfig((cfg) => {
		return applyDefaultModelPrimaryUpdate({
			cfg,
			modelRaw,
			field: "model"
		});
	});
	logConfigUpdated(runtime);
	runtime.log(`Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`);
}
//#endregion
export { modelsSetCommand };
