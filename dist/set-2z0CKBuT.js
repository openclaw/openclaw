import { i as resolveAgentModelPrimaryValue } from "./model-input-ChW9XXsQ.js";
import { r as logConfigUpdated } from "./logging-t-RUPR6R.js";
import { t as applyDefaultModelPrimaryUpdate, u as updateConfig } from "./shared-CXerptPG.js";
import { r as repairCodexRuntimePluginInstallForModelSelection } from "./codex-runtime-plugin-install-B70xNAdC.js";
//#region src/commands/models/set.ts
async function modelsSetCommand(modelRaw, runtime) {
	const updated = await updateConfig((cfg, context) => {
		return applyDefaultModelPrimaryUpdate({
			cfg,
			resolveCfg: context.runtimeConfig,
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
