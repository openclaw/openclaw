import { i as resolveAgentModelPrimaryValue } from "./model-input-iH6kLgu0.js";
import { n as logConfigUpdated } from "./logging-DfSCJjI7.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-CgfCs4MA.js";
import { n as repairCodexRuntimePluginInstallForModelSelection } from "./codex-runtime-plugin-install-D1HPyXie.js";
//#region src/commands/models/set.ts
async function modelsSetCommand(modelRaw, runtime) {
	const updated = await updateConfig((cfg) => {
		return applyDefaultModelPrimaryUpdate({
			cfg,
			modelRaw,
			field: "model"
		});
	});
	const repaired = await repairCodexRuntimePluginInstallForModelSelection({
		cfg: updated,
		model: resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw
	});
	for (const warning of repaired.warnings) runtime.error?.(warning);
	logConfigUpdated(runtime);
	runtime.log(`Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`);
}
//#endregion
export { modelsSetCommand };
