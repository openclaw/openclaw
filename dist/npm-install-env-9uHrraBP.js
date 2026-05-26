import fs from "node:fs";
import path from "node:path";
//#region src/infra/npm-install-env.ts
const NPM_CONFIG_SCRIPT_SHELL_KEYS = ["NPM_CONFIG_SCRIPT_SHELL", "npm_config_script_shell"];
const NPM_CONFIG_KEYS_TO_RESET = new Set([
	"npm_config_cache",
	"npm_config_dry_run",
	"npm_config_global",
	"npm_config_include_workspace_root",
	"npm_config_ignore_scripts",
	"npm_config_location",
	"npm_config_legacy_peer_deps",
	"npm_config_prefix",
	"npm_config_strict_peer_deps",
	"npm_config_workspace",
	"npm_config_workspaces"
]);
function createNpmProjectInstallEnv(env, options = {}) {
	const nextEnv = { ...env };
	for (const key of Object.keys(nextEnv)) if (NPM_CONFIG_KEYS_TO_RESET.has(key.toLowerCase())) delete nextEnv[key];
	const installEnv = {
		...nextEnv,
		npm_config_dry_run: "false",
		npm_config_fetch_retries: nextEnv.npm_config_fetch_retries ?? "5",
		npm_config_fetch_retry_maxtimeout: nextEnv.npm_config_fetch_retry_maxtimeout ?? "120000",
		npm_config_fetch_retry_mintimeout: nextEnv.npm_config_fetch_retry_mintimeout ?? "10000",
		npm_config_fetch_timeout: nextEnv.npm_config_fetch_timeout ?? "300000",
		npm_config_global: "false",
		npm_config_location: "project",
		npm_config_package_lock: "false",
		npm_config_save: "false",
		...options.cacheDir ? { npm_config_cache: options.cacheDir } : {}
	};
	applyPosixNpmScriptShellEnv(installEnv);
	return installEnv;
}
function hasNpmScriptShellSetting(env) {
	return NPM_CONFIG_SCRIPT_SHELL_KEYS.some((key) => Boolean(env[key]?.trim()));
}
function resolvePosixNpmScriptShell(env) {
	if (process.platform === "win32") return null;
	if (fs.existsSync("/bin/sh")) return "/bin/sh";
	const shell = env.SHELL?.trim();
	return shell && path.isAbsolute(shell) && fs.existsSync(shell) ? shell : null;
}
function applyPosixNpmScriptShellEnv(env) {
	if (hasNpmScriptShellSetting(env)) return;
	const scriptShell = resolvePosixNpmScriptShell(env);
	if (scriptShell) env.NPM_CONFIG_SCRIPT_SHELL = scriptShell;
}
//#endregion
export { resolvePosixNpmScriptShell as i, createNpmProjectInstallEnv as n, hasNpmScriptShellSetting as r, applyPosixNpmScriptShellEnv as t };
