import { i as getRuntimeConfig } from "./io-B3cB3MOo.js";
import { _ as setRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import "./config-Dh6CigU2.js";
import { l as getModelsCommandSecretTargetIds } from "./command-secret-targets-CgBeI_pc.js";
import { t as resolveCommandConfigWithSecrets } from "./command-config-resolution-r-_Ypiq3.js";
//#region src/commands/models/load-config.ts
async function loadModelsConfigWithSource(params) {
	const runtimeConfig = getRuntimeConfig();
	const pinnedSourceConfig = getRuntimeConfigSourceSnapshot();
	const sourceConfig = pinnedSourceConfig ?? runtimeConfig;
	const { resolvedConfig, diagnostics } = await resolveCommandConfigWithSecrets({
		config: runtimeConfig,
		commandName: params.commandName,
		targetIds: getModelsCommandSecretTargetIds(),
		runtime: params.runtime
	});
	if (pinnedSourceConfig) setRuntimeConfigSnapshot(resolvedConfig, sourceConfig);
	else setRuntimeConfigSnapshot(resolvedConfig);
	return {
		sourceConfig,
		resolvedConfig,
		diagnostics
	};
}
async function loadModelsConfig(params) {
	return (await loadModelsConfigWithSource(params)).resolvedConfig;
}
//#endregion
export { loadModelsConfigWithSource as n, loadModelsConfig as t };
