import { i as createNpmProjectInstallEnv } from "./npm-install-env-BDr63VWf.js";
//#region src/infra/safe-package-install.ts
function createSafeNpmInstallEnv(env, options = {}) {
	const nextEnv = {
		...createNpmProjectInstallEnv(env, options),
		COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
		NPM_CONFIG_IGNORE_SCRIPTS: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_ignore_scripts: "true",
		npm_config_legacy_peer_deps: options.legacyPeerDeps ? "true" : "false",
		npm_config_package_lock: options.packageLock === true ? "true" : "false",
		npm_config_strict_peer_deps: "false",
		...options.packageLock === true ? { npm_config_save: "true" } : {},
		...options.ignoreWorkspaces ? { npm_config_workspaces: "false" } : {}
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
		...options.omitPeer ? ["--omit=peer"] : [],
		...options.legacyPeerDeps ? ["--legacy-peer-deps"] : [],
		...options.loglevel ? [`--loglevel=${options.loglevel}`] : [],
		"--ignore-scripts",
		...options.ignoreWorkspaces ? ["--workspaces=false"] : [],
		...options.noAudit ? ["--no-audit"] : [],
		...options.noFund ? ["--no-fund"] : []
	];
}
//#endregion
export { createSafeNpmInstallEnv as n, createSafeNpmInstallArgs as t };
