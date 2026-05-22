//#region src/infra/npm-install-env.ts
const NPM_CONFIG_KEYS_TO_RESET = new Set([
	"npm_config_cache",
	"npm_config_dry_run",
	"npm_config_global",
	"npm_config_include_workspace_root",
	"npm_config_ignore_scripts",
	"npm_config_location",
	"npm_config_prefix",
	"npm_config_workspace",
	"npm_config_workspaces"
]);
function createNpmProjectInstallEnv(env, options = {}) {
	const nextEnv = { ...env };
	for (const key of Object.keys(nextEnv)) if (NPM_CONFIG_KEYS_TO_RESET.has(key.toLowerCase())) delete nextEnv[key];
	return {
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
}
//#endregion
//#region src/infra/safe-package-install.ts
function createSafeNpmInstallEnv(env, options = {}) {
	const nextEnv = {
		...createNpmProjectInstallEnv(env, options),
		COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
		NPM_CONFIG_IGNORE_SCRIPTS: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_ignore_scripts: "true",
		npm_config_package_lock: options.packageLock === true ? "true" : "false",
		...options.ignoreWorkspaces ? { npm_config_workspaces: "false" } : {},
		...options.legacyPeerDeps ? { npm_config_legacy_peer_deps: "true" } : {}
	};
	if (options.quiet) Object.assign(nextEnv, {
		npm_config_loglevel: "error",
		npm_config_progress: "false",
		npm_config_yes: "true"
	});
	return nextEnv;
}
function createSafeNpmInstallArgs(options = {}) {
	return [
		"install",
		...options.omitDev ? ["--omit=dev"] : [],
		...options.loglevel ? [`--loglevel=${options.loglevel}`] : [],
		"--ignore-scripts",
		...options.ignoreWorkspaces ? ["--workspaces=false"] : [],
		...options.noAudit ? ["--no-audit"] : [],
		...options.noFund ? ["--no-fund"] : []
	];
}
//#endregion
export { createSafeNpmInstallEnv as n, createSafeNpmInstallArgs as t };
