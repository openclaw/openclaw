import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { t as resolveCliCommandPathPolicy } from "./command-path-policy-Dc5x3coi.js";
//#region src/cli/command-startup-policy.ts
function shouldBypassConfigGuardForCommandPath(commandPath) {
	return resolveCliCommandPathPolicy(commandPath).bypassConfigGuard;
}
function shouldSkipRouteConfigGuardForCommandPath(params) {
	const routeConfigGuard = resolveCliCommandPathPolicy(params.commandPath).routeConfigGuard;
	return routeConfigGuard === "always" || routeConfigGuard === "when-suppressed" && params.suppressDoctorStdout;
}
function shouldLoadPluginsForCommandPath(params) {
	return shouldLoadPlugins({
		loadPlugins: resolveCliCommandPathPolicy(params.commandPath).loadPlugins,
		argv: params.argv,
		commandPath: params.commandPath,
		jsonOutputMode: params.jsonOutputMode
	});
}
function shouldLoadPlugins(params) {
	const loadPlugins = params.loadPlugins;
	if (typeof loadPlugins === "function") return loadPlugins({
		argv: params.argv ?? [],
		commandPath: params.commandPath,
		jsonOutputMode: params.jsonOutputMode
	});
	return loadPlugins === "always" || loadPlugins === "text-only" && !params.jsonOutputMode;
}
function shouldHideCliBannerForCommandPath(commandPath, env = process.env) {
	return isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER) || resolveCliCommandPathPolicy(commandPath).hideBanner;
}
function shouldEnsureCliPathForCommandPath(commandPath) {
	return commandPath.length === 0 || resolveCliCommandPathPolicy(commandPath).ensureCliPath;
}
function resolveCliStartupPolicy(params) {
	const suppressDoctorStdout = params.jsonOutputMode;
	const commandPolicy = resolveCliCommandPathPolicy(params.commandPath);
	return {
		suppressDoctorStdout,
		hideBanner: isTruthyEnvValue((params.env ?? process.env).OPENCLAW_HIDE_BANNER) || commandPolicy.hideBanner,
		skipConfigGuard: params.routeMode ? commandPolicy.routeConfigGuard === "always" || commandPolicy.routeConfigGuard === "when-suppressed" && suppressDoctorStdout : false,
		loadPlugins: shouldLoadPlugins({
			argv: params.argv,
			commandPath: params.commandPath,
			jsonOutputMode: params.jsonOutputMode,
			loadPlugins: commandPolicy.loadPlugins
		}),
		pluginRegistry: commandPolicy.pluginRegistry
	};
}
//#endregion
export { shouldLoadPluginsForCommandPath as a, shouldHideCliBannerForCommandPath as i, shouldBypassConfigGuardForCommandPath as n, shouldSkipRouteConfigGuardForCommandPath as o, shouldEnsureCliPathForCommandPath as r, resolveCliStartupPolicy as t };
