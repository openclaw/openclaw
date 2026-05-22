import { n as resolveAgentModelPrimaryValue } from "./model-input-gjsFWrBi.js";
import { n as logConfigUpdated } from "./logging-DPg6HkJQ.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-CuyMvlgj.js";
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
