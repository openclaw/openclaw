import { t as resolveCliArgvInvocation } from "./argv-invocation-BEbwVBGx.js";
import { t as createLazyImportLoader } from "./lazy-promise-B6on3yPt.js";
import { g as loggingState } from "./logger-C-XERP1U.js";
import { a as routeLogsToStderr } from "./console-X2BXJBel.js";
import { t as resolveCliCommandPathPolicy } from "./command-path-policy-DBSNK4R7.js";
import { t as resolveCliStartupPolicy } from "./command-startup-policy-C11aaXOi.js";
//#region src/cli/plugin-registry-loader.ts
const pluginRegistryModuleLoader = createLazyImportLoader(() => import("./plugin-registry-BGu2-B28.js"));
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
const configGuardModuleLoader = createLazyImportLoader(() => import("./config-guard-CX-KGtDa.js"));
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
	const { emitCliBanner } = await import("./banner-7WfJEC1a.js");
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
