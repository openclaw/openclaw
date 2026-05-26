import { t as resolveCliArgvInvocation } from "./argv-invocation-Bmipv42U.js";
import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { g as loggingState } from "./logger-DIiFDaHc.js";
import { a as routeLogsToStderr } from "./console-DTusPN3F.js";
import { t as resolveCliCommandPathPolicy } from "./command-path-policy-Bk_Rxblh.js";
import { t as resolveCliStartupPolicy } from "./command-startup-policy-JITG1rte.js";
//#region src/cli/plugin-registry-loader.ts
const pluginRegistryModuleLoader = createLazyImportLoader(() => import("./plugin-registry-DQRPc5I8.js"));
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
const configGuardModuleLoader = createLazyImportLoader(() => import("./config-guard-BcB2IV2A.js"));
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
	const { emitCliBanner } = await import("./banner-DPyKVokt.js");
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
