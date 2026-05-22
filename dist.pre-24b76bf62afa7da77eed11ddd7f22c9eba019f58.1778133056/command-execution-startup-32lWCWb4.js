import { t as resolveCliArgvInvocation } from "./argv-invocation-BqQrcVeY.js";
import { t as createLazyImportLoader } from "./lazy-promise-BWWZqHu4.js";
import { h as loggingState } from "./logger-rPxGv0hY.js";
import { a as routeLogsToStderr } from "./console-FbMq-ElM.js";
import { t as resolveCliCommandPathPolicy } from "./command-path-policy-qJwawqsG.js";
import { t as resolveCliStartupPolicy } from "./command-startup-policy-CbRGuFHt.js";
//#region src/cli/plugin-registry-loader.ts
const pluginRegistryModuleLoader = createLazyImportLoader(() => import("./plugin-registry-CeqmiDh5.js"));
function loadPluginRegistryModule() {
	return pluginRegistryModuleLoader.load();
}
async function ensureCliPluginRegistryLoaded(params) {
	const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
	const previousForceStderr = loggingState.forceConsoleToStderr;
	if (params.routeLogsToStderr) loggingState.forceConsoleToStderr = true;
	try {
		ensurePluginRegistryLoaded({
			scope: params.scope,
			...params.config ? { config: params.config } : {},
			...params.activationSourceConfig ? { activationSourceConfig: params.activationSourceConfig } : {}
		});
	} finally {
		loggingState.forceConsoleToStderr = previousForceStderr;
	}
}
//#endregion
//#region src/cli/command-bootstrap.ts
const configGuardModuleLoader = createLazyImportLoader(() => import("./config-guard-DIgZ2d8O.js"));
function loadConfigGuardModule() {
	return configGuardModuleLoader.load();
}
async function ensureCliCommandBootstrap(params) {
	if (!params.skipConfigGuard) {
		const { ensureConfigReady } = await loadConfigGuardModule();
		await ensureConfigReady({
			runtime: params.runtime,
			commandPath: params.commandPath,
			...params.allowInvalid ? { allowInvalid: true } : {},
			...params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}
		});
	}
	if (!params.loadPlugins) return;
	await ensureCliPluginRegistryLoaded({
		scope: (params.pluginRegistry ?? resolveCliCommandPathPolicy(params.commandPath).pluginRegistry).scope,
		routeLogsToStderr: params.suppressDoctorStdout
	});
}
//#endregion
//#region src/cli/command-execution-startup.ts
function resolveCliExecutionStartupContext(params) {
	const invocation = resolveCliArgvInvocation(params.argv);
	const { commandPath } = invocation;
	return {
		invocation,
		commandPath,
		startupPolicy: resolveCliStartupPolicy({
			argv: params.argv,
			commandPath,
			jsonOutputMode: params.jsonOutputMode,
			env: params.env,
			routeMode: params.routeMode
		})
	};
}
async function applyCliExecutionStartupPresentation(params) {
	if (params.startupPolicy.suppressDoctorStdout && params.routeLogsToStderrOnSuppress !== false) routeLogsToStderr();
	if (params.startupPolicy.hideBanner || params.showBanner === false || !params.version) return;
	const { emitCliBanner } = await import("./banner-C-IlKmSt.js");
	if (params.argv) {
		emitCliBanner(params.version, { argv: params.argv });
		return;
	}
	emitCliBanner(params.version);
}
async function ensureCliExecutionBootstrap(params) {
	await ensureCliCommandBootstrap({
		runtime: params.runtime,
		commandPath: params.commandPath,
		suppressDoctorStdout: params.startupPolicy.suppressDoctorStdout,
		allowInvalid: params.allowInvalid,
		loadPlugins: params.loadPlugins ?? params.startupPolicy.loadPlugins,
		pluginRegistry: params.startupPolicy.pluginRegistry,
		skipConfigGuard: params.skipConfigGuard ?? params.startupPolicy.skipConfigGuard
	});
}
//#endregion
export { ensureCliExecutionBootstrap as n, resolveCliExecutionStartupContext as r, applyCliExecutionStartupPresentation as t };
