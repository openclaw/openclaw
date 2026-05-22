import { i as getRuntimeConfig } from "./io-rEK73C2c.js";
import { _ as setRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-Dg8HhGX3.js";
import "./config-CWWzPkaY.js";
import { l as getModelsCommandSecretTargetIds } from "./command-secret-targets-DmDTs3cw.js";
import { t as resolveCommandConfigWithSecrets } from "./command-config-resolution-rIxP9aBV.js";
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
