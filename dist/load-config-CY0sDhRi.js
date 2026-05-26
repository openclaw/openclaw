import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { _ as setRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-tLK3Mx7y.js";
import "./config-CzeRK-GW.js";
import { i as getModelsCommandSecretTargetIds } from "./command-secret-targets-DHIk2CaO.js";
import { t as resolveCommandConfigWithSecrets } from "./command-config-resolution-CtOow2Pe.js";
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
