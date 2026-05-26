import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
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
const NPM_FRESHNESS_BYPASS_KEYS = [
	"NPM_CONFIG_BEFORE",
	"npm_config_before",
	"NPM_CONFIG_MIN_RELEASE_AGE",
	"npm_config_min_release_age",
	"NPM_CONFIG_MIN-RELEASE-AGE",
	"npm_config_min-release-age"
];
const NPM_CONFIG_PATH_PROBE_PARENT_ENV_KEYS = [
	"PATH",
	"Path",
	"PATHEXT",
	"SystemRoot",
	"ComSpec"
];
function resolveEnvPath(env, upperKey, lowerKey) {
	const raw = env[upperKey]?.trim() || env[lowerKey]?.trim();
	return raw ? resolveNpmConfigPath(raw, env) : null;
}
function resolveHomeNpmrc(env) {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
	return path.join(home, ".npmrc");
}
function replaceNpmEnvRefs(value, env) {
	return value.replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/gu, (original, escapes, name, modifier) => {
		const fallback = modifier === "?" ? "" : `\${${name}}`;
		const resolved = env[name] !== void 0 ? env[name] : fallback;
		if (escapes.length % 2) return original.slice((escapes.length + 1) / 2);
		return `${escapes.slice(escapes.length / 2)}${resolved}`;
	});
}
function resolveNpmConfigPath(rawPath, env) {
	const expanded = replaceNpmEnvRefs(rawPath, env);
	const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
	return (process.platform === "win32" ? /^~(\/|\\)/u : /^~\//u).test(expanded) && home ? path.resolve(home, expanded.slice(2)) : path.resolve(expanded);
}
function createNpmConfigPathProbeEnv(env) {
	const probeEnv = { ...env };
	for (const key of NPM_FRESHNESS_BYPASS_KEYS) delete probeEnv[key];
	for (const key of NPM_CONFIG_PATH_PROBE_PARENT_ENV_KEYS) if (probeEnv[key] == null && process.env[key] != null) probeEnv[key] = process.env[key];
	return probeEnv;
}
function readNpmGlobalConfigPath(env, scope) {
	try {
		const raw = execFileSync("npm", [
			"config",
			"get",
			"globalconfig"
		], {
			encoding: "utf-8",
			env: {
				...createNpmConfigPathProbeEnv(env),
				...scope.npmConfigPrefix ? { npm_config_prefix: scope.npmConfigPrefix } : {}
			},
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 2e3
		}).trim();
		return raw && raw !== "null" && raw !== "undefined" ? raw : null;
	} catch {
		return null;
	}
}
function resolveScopedProjectNpmrc(scope) {
	const scopedCwd = scope.npmConfigCwd?.trim();
	if (scopedCwd) return path.join(scopedCwd, ".npmrc");
	try {
		const cwd = process.cwd();
		return cwd ? path.join(cwd, ".npmrc") : null;
	} catch {
		return null;
	}
}
function resolveScopedGlobalNpmrc(scope) {
	const prefix = scope.npmConfigPrefix?.trim();
	return prefix ? path.join(prefix, "etc", "npmrc") : null;
}
function resolveNpmConfigFiles(env, scope = {}) {
	const files = [
		resolveScopedProjectNpmrc(scope),
		resolveEnvPath(env, "NPM_CONFIG_USERCONFIG", "npm_config_userconfig") ?? resolveHomeNpmrc(env),
		resolveEnvPath(env, "NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig"),
		resolveScopedGlobalNpmrc(scope),
		readNpmGlobalConfigPath(env, scope)
	];
	return [...new Set(files.filter((file) => Boolean(file)))];
}
function hasNpmrcConfigKey(filePath, key) {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		return new RegExp(`^\\s*${escapedKey}\\s*=`, "imu").test(raw);
	} catch {
		return false;
	}
}
function hasRawNpmConfigKey(env, key, scope) {
	return resolveNpmConfigFiles(env, scope).some((file) => hasNpmrcConfigKey(file, key));
}
function resolveNpmFreshnessBypassMode(env, scope) {
	if (process.platform === "win32") return "before";
	if (hasRawNpmConfigKey(env, "min-release-age", scope)) return "min-release-age";
	return hasRawNpmConfigKey(env, "before", scope) ? "before" : "min-release-age";
}
function createNpmFreshnessBypassArgs(env = process.env, now = /* @__PURE__ */ new Date(), scope = {}) {
	if (resolveNpmFreshnessBypassMode(env, scope) === "min-release-age") return ["--min-release-age=0"];
	return [`--before=${now.toISOString()}`];
}
function applyNpmFreshnessBypassEnv(env, now = /* @__PURE__ */ new Date(), scope = {}) {
	const [arg] = createNpmFreshnessBypassArgs(env, now, scope);
	for (const key of NPM_FRESHNESS_BYPASS_KEYS) {
		if (process.platform === "win32" && key.includes("-")) {
			delete env[key];
			continue;
		}
		env[key] = "";
	}
	if (arg?.startsWith("--before=")) env.npm_config_before = arg.slice(9);
	else if (arg === "--min-release-age=0") env.npm_config_min_release_age = "0";
}
function createNpmProjectInstallEnv(env, options = {}, now = /* @__PURE__ */ new Date()) {
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
	applyNpmFreshnessBypassEnv(installEnv, now, options);
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
export { createNpmProjectInstallEnv as i, applyPosixNpmScriptShellEnv as n, createNpmFreshnessBypassArgs as r, applyNpmFreshnessBypassEnv as t };
