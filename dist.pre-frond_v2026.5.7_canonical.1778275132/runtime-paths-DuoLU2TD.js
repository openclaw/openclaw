import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as resolveNodeStartupTlsEnvironment } from "./node-startup-env-BFCq2yT0.js";
import { _ as resolveNodeSystemdServiceName, a as GATEWAY_SERVICE_MARKER, c as NODE_SERVICE_MARKER, d as resolveGatewayLaunchAgentLabel, g as resolveNodeLaunchAgentLabel, i as GATEWAY_SERVICE_KIND, l as NODE_WINDOWS_TASK_SCRIPT_NAME, m as resolveGatewayWindowsTaskName, p as resolveGatewaySystemdServiceName, s as NODE_SERVICE_KIND, t as resolveGatewayStateDir, v as resolveNodeWindowsTaskName } from "./paths-nw72TSPj.js";
import { n as VERSION } from "./version-DdTF4eka.js";
import { r as isSupportedNodeVersion } from "./runtime-guard-BSNxAzOt.js";
import { t as resolveStableNodePath } from "./stable-node-path-CtvO2_Yy.js";
import { n as getWindowsProgramFilesRoots } from "./windows-install-roots-2thIF_8W.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/daemon/service-env.ts
const SERVICE_PROXY_ENV_KEYS = [
	"OPENCLAW_PROXY_URL",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy"
];
function readServiceProxyEnvironment(env) {
	const proxyUrl = normalizeOptionalString(env.OPENCLAW_PROXY_URL);
	return proxyUrl ? { OPENCLAW_PROXY_URL: proxyUrl } : {};
}
function normalizeServicePathDir(dir) {
	const trimmed = dir?.trim();
	if (!trimmed || !path.posix.isAbsolute(trimmed)) return;
	return path.posix.normalize(trimmed);
}
function realpathServicePathDir(dir) {
	try {
		return path.posix.normalize(fs.realpathSync.native(dir));
	} catch {
		return;
	}
}
function realpathExistingServicePathDir(dir) {
	const parts = [];
	let current = dir;
	while (current && current !== path.posix.dirname(current)) {
		const realCurrent = realpathServicePathDir(current);
		if (realCurrent) return path.posix.normalize(path.posix.join(realCurrent, ...parts.toReversed()));
		parts.push(path.posix.basename(current));
		current = path.posix.dirname(current);
	}
	const realRoot = realpathServicePathDir(current);
	return realRoot ? path.posix.normalize(path.posix.join(realRoot, ...parts.toReversed())) : void 0;
}
function isSameOrChildPath(candidate, parent) {
	return candidate === parent || candidate.startsWith(`${parent}/`);
}
function isUnsafeProcPath(candidate) {
	return candidate === "/proc" || candidate.startsWith("/proc/");
}
function isWorkspaceDerivedPath(dir, options) {
	if (isUnsafeProcPath(dir)) return true;
	const cwd = normalizeServicePathDir(options.cwd ?? process.cwd());
	if (!cwd) return false;
	const home = normalizeServicePathDir(options.home);
	if (home && cwd === home) return false;
	if (isSameOrChildPath(dir, cwd)) return true;
	const realDir = realpathExistingServicePathDir(dir);
	const realCwd = realpathServicePathDir(cwd);
	const realHome = home ? realpathServicePathDir(home) : void 0;
	return Boolean(realDir && realCwd && realHome !== realCwd && isSameOrChildPath(realDir, realCwd));
}
function addEnvConfiguredBinDir(dirs, dir, options) {
	const normalized = normalizeServicePathDir(dir);
	if (!normalized || isWorkspaceDerivedPath(normalized, options)) return;
	dirs.push(normalized);
}
function appendSubdir(base, subdir) {
	if (!base) return;
	return base.endsWith(`/${subdir}`) ? base : path.posix.join(base, subdir);
}
function addExistingDir(dirs, candidate, existsSync) {
	if (existsSync(candidate)) dirs.push(candidate);
}
function addCommonUserBinDirs(dirs, home, existsSync, includeMissingDefaults) {
	const addDefault = includeMissingDefaults ? (candidate) => dirs.push(candidate) : (candidate) => addExistingDir(dirs, candidate, existsSync);
	addDefault(`${home}/.local/bin`);
	addDefault(`${home}/.npm-global/bin`);
	addDefault(`${home}/bin`);
	addExistingDir(dirs, `${home}/.volta/bin`, existsSync);
	addExistingDir(dirs, `${home}/.asdf/shims`, existsSync);
	addExistingDir(dirs, `${home}/.bun/bin`, existsSync);
}
function addCommonEnvConfiguredBinDirs(dirs, env, options) {
	addEnvConfiguredBinDir(dirs, env?.PNPM_HOME, options);
	addEnvConfiguredBinDir(dirs, appendSubdir(env?.NPM_CONFIG_PREFIX, "bin"), options);
	addEnvConfiguredBinDir(dirs, appendSubdir(env?.BUN_INSTALL, "bin"), options);
	addEnvConfiguredBinDir(dirs, appendSubdir(env?.VOLTA_HOME, "bin"), options);
	addEnvConfiguredBinDir(dirs, appendSubdir(env?.ASDF_DATA_DIR, "shims"), options);
}
function addNixProfileBinDirs(dirs, home, env, options, includeMissingDefault, existsSync) {
	const nixProfiles = env?.NIX_PROFILES?.trim();
	if (nixProfiles) for (const profile of nixProfiles.split(/\s+/).toReversed()) addEnvConfiguredBinDir(dirs, appendSubdir(profile, "bin"), options);
	else {
		const defaultProfileBin = `${home}/.nix-profile/bin`;
		if (includeMissingDefault) dirs.push(defaultProfileBin);
		else addExistingDir(dirs, defaultProfileBin, existsSync);
	}
}
function resolveSystemPathDirs(platform) {
	if (platform === "darwin") return [
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin"
	];
	if (platform === "linux") return [
		"/usr/local/bin",
		"/usr/bin",
		"/bin"
	];
	return [];
}
/**
* Resolve common user bin directories for macOS.
* These are paths where npm global installs and node version managers typically place binaries.
*
* Key differences from Linux:
* - fnm: macOS uses ~/Library/Application Support/fnm (not ~/.local/share/fnm)
* - pnpm: macOS uses ~/Library/pnpm (not ~/.local/share/pnpm)
*/
function resolveDarwinUserBinDirs(home, env, existsSync = fs.existsSync, options = {}) {
	if (!home) return [];
	const dirs = [];
	const pathOptions = {
		...options,
		home
	};
	const includeMissingUserBinDefaults = options.includeMissingUserBinDefaults ?? true;
	addCommonEnvConfiguredBinDirs(dirs, env, pathOptions);
	addEnvConfiguredBinDir(dirs, env?.NVM_DIR, pathOptions);
	addEnvConfiguredBinDir(dirs, appendSubdir(env?.FNM_DIR, "aliases/default/bin"), pathOptions);
	addCommonUserBinDirs(dirs, home, existsSync, includeMissingUserBinDefaults);
	addNixProfileBinDirs(dirs, home, env, pathOptions, includeMissingUserBinDefaults, existsSync);
	addExistingDir(dirs, `${home}/Library/Application Support/fnm/aliases/default/bin`, existsSync);
	addExistingDir(dirs, `${home}/.fnm/aliases/default/bin`, existsSync);
	addExistingDir(dirs, `${home}/Library/pnpm`, existsSync);
	addExistingDir(dirs, `${home}/.local/share/pnpm`, existsSync);
	return dirs;
}
/**
* Resolve common user bin directories for Linux.
* These are paths where npm global installs and node version managers typically place binaries.
*/
function resolveLinuxUserBinDirs(home, env, existsSync = fs.existsSync, options = {}) {
	if (!home) return [];
	const dirs = [];
	const pathOptions = {
		...options,
		home
	};
	const includeMissingUserBinDefaults = options.includeMissingUserBinDefaults ?? true;
	addCommonEnvConfiguredBinDirs(dirs, env, pathOptions);
	addEnvConfiguredBinDir(dirs, appendSubdir(env?.NVM_DIR, "current/bin"), pathOptions);
	addEnvConfiguredBinDir(dirs, appendSubdir(env?.FNM_DIR, "aliases/default/bin"), pathOptions);
	addEnvConfiguredBinDir(dirs, appendSubdir(env?.FNM_DIR, "current/bin"), pathOptions);
	addCommonUserBinDirs(dirs, home, existsSync, includeMissingUserBinDefaults);
	addNixProfileBinDirs(dirs, home, env, pathOptions, includeMissingUserBinDefaults, existsSync);
	addExistingDir(dirs, `${home}/.nvm/current/bin`, existsSync);
	addExistingDir(dirs, `${home}/.local/share/fnm/aliases/default/bin`, existsSync);
	addExistingDir(dirs, `${home}/.local/share/fnm/current/bin`, existsSync);
	addExistingDir(dirs, `${home}/.fnm/aliases/default/bin`, existsSync);
	addExistingDir(dirs, `${home}/.fnm/current/bin`, existsSync);
	addExistingDir(dirs, `${home}/.local/share/pnpm`, existsSync);
	return dirs;
}
function getMinimalServicePathParts(options = {}) {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") return [];
	const parts = [];
	const extraDirs = options.extraDirs ?? [];
	const systemDirs = resolveSystemPathDirs(platform);
	const includeUserDirs = options.includeUserDirs ?? platform !== "darwin";
	const existsSync = options.existsSync ?? fs.existsSync;
	const userDirs = includeUserDirs ? platform === "linux" ? resolveLinuxUserBinDirs(options.home, options.env, existsSync, options) : platform === "darwin" ? resolveDarwinUserBinDirs(options.home, options.env, existsSync, options) : [] : [];
	const add = (dir) => {
		if (!dir) return;
		if (!parts.includes(dir)) parts.push(dir);
	};
	for (const dir of extraDirs) add(dir);
	for (const dir of userDirs) add(dir);
	for (const dir of systemDirs) add(dir);
	return parts;
}
function getMinimalServicePathPartsFromEnv(options = {}) {
	const env = options.env ?? process.env;
	return getMinimalServicePathParts({
		...options,
		home: options.home ?? env.HOME,
		env
	});
}
function buildMinimalServicePath(options = {}) {
	const env = options.env ?? process.env;
	if ((options.platform ?? process.platform) === "win32") return env.PATH ?? "";
	return getMinimalServicePathPartsFromEnv({
		...options,
		env
	}).join(path.posix.delimiter);
}
function buildServiceEnvironment(params) {
	const { env, port, launchdLabel, extraPathDirs } = params;
	const platform = params.platform ?? process.platform;
	const sharedEnv = resolveSharedServiceEnvironmentFields(env, platform, extraPathDirs, params.execPath);
	const profile = env.OPENCLAW_PROFILE;
	const wrapperPath = normalizeOptionalString(env.OPENCLAW_WRAPPER);
	const resolvedLaunchdLabel = launchdLabel || (platform === "darwin" ? resolveGatewayLaunchAgentLabel(profile) : void 0);
	const systemdUnit = `${resolveGatewaySystemdServiceName(profile)}.service`;
	return {
		...buildCommonServiceEnvironment(env, sharedEnv),
		OPENCLAW_PROFILE: profile,
		OPENCLAW_WRAPPER: wrapperPath,
		OPENCLAW_GATEWAY_PORT: String(port),
		OPENCLAW_LAUNCHD_LABEL: resolvedLaunchdLabel,
		OPENCLAW_SYSTEMD_UNIT: systemdUnit,
		OPENCLAW_WINDOWS_TASK_NAME: resolveGatewayWindowsTaskName(profile),
		OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
		OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
		OPENCLAW_SERVICE_VERSION: VERSION
	};
}
function buildNodeServiceEnvironment(params) {
	const { env, extraPathDirs } = params;
	const sharedEnv = resolveSharedServiceEnvironmentFields(env, params.platform ?? process.platform, extraPathDirs, params.execPath);
	const gatewayToken = normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN);
	const allowInsecurePrivateWs = normalizeOptionalString(env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS);
	return {
		...buildCommonServiceEnvironment(env, sharedEnv),
		OPENCLAW_GATEWAY_TOKEN: gatewayToken,
		OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: allowInsecurePrivateWs,
		OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
		OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
		OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
		OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
		OPENCLAW_LOG_PREFIX: "node",
		OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
		OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND,
		OPENCLAW_SERVICE_VERSION: VERSION
	};
}
function buildCommonServiceEnvironment(env, sharedEnv) {
	const serviceEnv = {
		HOME: env.HOME,
		TMPDIR: sharedEnv.tmpDir,
		NODE_EXTRA_CA_CERTS: sharedEnv.nodeCaCerts,
		NODE_USE_SYSTEM_CA: sharedEnv.nodeUseSystemCa,
		OPENCLAW_STATE_DIR: sharedEnv.stateDir,
		OPENCLAW_CONFIG_PATH: sharedEnv.configPath,
		...sharedEnv.proxyEnv
	};
	if (sharedEnv.minimalPath) serviceEnv.PATH = sharedEnv.minimalPath;
	return serviceEnv;
}
function resolveServiceTmpDir(env, platform) {
	if (platform === "darwin") try {
		return path.join(resolveGatewayStateDir(env), "tmp");
	} catch {
		return env.TMPDIR?.trim() || os.tmpdir();
	}
	return env.TMPDIR?.trim() || os.tmpdir();
}
function resolveSharedServiceEnvironmentFields(env, platform, extraPathDirs, execPath) {
	const stateDir = env.OPENCLAW_STATE_DIR;
	const configPath = env.OPENCLAW_CONFIG_PATH;
	const tmpDir = resolveServiceTmpDir(env, platform);
	const startupTlsEnv = resolveNodeStartupTlsEnvironment({
		env,
		platform,
		execPath
	});
	return {
		stateDir,
		configPath,
		tmpDir,
		minimalPath: platform === "win32" ? void 0 : buildMinimalServicePath({
			env,
			platform,
			extraDirs: extraPathDirs
		}),
		proxyEnv: readServiceProxyEnvironment(env),
		nodeCaCerts: startupTlsEnv.NODE_EXTRA_CA_CERTS,
		nodeUseSystemCa: startupTlsEnv.NODE_USE_SYSTEM_CA
	};
}
//#endregion
//#region src/daemon/service-path-policy.ts
function getPathModule$1(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}
function normalizeServicePathEntry(entry, platform) {
	const normalized = getPathModule$1(platform).normalize(entry).replaceAll("\\", "/");
	if (platform === "win32") return normalizeLowercaseStringOrEmpty(normalized);
	return normalized;
}
function isNonMinimalServicePathEntry(entry, platform) {
	if (platform === "win32") return false;
	const normalized = normalizeServicePathEntry(entry, platform);
	return normalized.includes("/.nvm/") || normalized.includes("/.fnm/") || normalized.includes("/.local/share/fnm/") || normalized.includes("/.volta/") || normalized.includes("/.asdf/") || normalized.includes("/.n/") || normalized.includes("/.nodenv/") || normalized.includes("/.nodebrew/") || normalized.includes("/nvs/") || normalized.includes("/.local/share/pnpm/") || normalized.includes("/pnpm/") || normalized.endsWith("/pnpm");
}
//#endregion
//#region src/daemon/runtime-paths.ts
const VERSION_MANAGER_MARKERS = [
	"/.nvm/",
	"/.fnm/",
	"/.local/share/fnm/",
	"/library/application support/fnm/",
	"/.volta/",
	"/.asdf/",
	"/.local/share/mise/",
	"/.n/",
	"/.nodenv/",
	"/.nodebrew/",
	"/nvs/"
];
function getPathModule(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}
function isNodeExecPath(execPath, platform) {
	const base = normalizeLowercaseStringOrEmpty(getPathModule(platform).basename(execPath));
	return base === "node" || base === "node.exe";
}
function normalizeForCompare(input, platform) {
	const normalized = getPathModule(platform).normalize(input).replaceAll("\\", "/");
	if (platform === "win32") return normalizeLowercaseStringOrEmpty(normalized);
	return normalized;
}
function buildSystemNodeCandidates(env, platform) {
	if (platform === "darwin") return [
		"/opt/homebrew/bin/node",
		"/opt/homebrew/opt/node/bin/node",
		"/opt/homebrew/opt/node@24/bin/node",
		"/opt/homebrew/opt/node@22/bin/node",
		"/usr/local/bin/node",
		"/usr/local/opt/node/bin/node",
		"/usr/local/opt/node@24/bin/node",
		"/usr/local/opt/node@22/bin/node",
		"/usr/bin/node"
	];
	if (platform === "linux") return ["/usr/local/bin/node", "/usr/bin/node"];
	if (platform === "win32") {
		const pathModule = getPathModule(platform);
		return getWindowsProgramFilesRoots(env).map((root) => pathModule.join(root, "nodejs", "node.exe"));
	}
	return [];
}
const execFileAsync = promisify(execFile);
async function resolveNodeVersion(nodePath, execFileImpl) {
	try {
		const { stdout } = await execFileImpl(nodePath, ["-p", "process.versions.node"], { encoding: "utf8" });
		const value = stdout.trim();
		return value ? value : null;
	} catch {
		return null;
	}
}
async function isVersionManagedRealNodePath(nodePath, platform) {
	try {
		return isVersionManagedNodePath(await fs$1.realpath(nodePath), platform);
	} catch {
		return false;
	}
}
function isVersionManagedNodePath(nodePath, platform = process.platform) {
	const normalized = normalizeLowercaseStringOrEmpty(normalizeForCompare(nodePath, platform));
	return VERSION_MANAGER_MARKERS.some((marker) => normalized.includes(marker));
}
function isSystemNodePath(nodePath, env = process.env, platform = process.platform) {
	const normalized = normalizeForCompare(nodePath, platform);
	return buildSystemNodeCandidates(env, platform).some((candidate) => {
		return normalized === normalizeForCompare(candidate, platform);
	});
}
async function resolveSystemNodePath(env = process.env, platform = process.platform) {
	const candidates = buildSystemNodeCandidates(env, platform);
	for (const candidate of candidates) try {
		await fs$1.access(candidate);
		return candidate;
	} catch {}
	return null;
}
async function resolveSystemNodeInfo(params) {
	const env = params.env ?? process.env;
	const platform = params.platform ?? process.platform;
	const execFileImpl = params.execFile ?? execFileAsync;
	let firstAvailable = null;
	for (const systemNode of buildSystemNodeCandidates(env, platform)) {
		try {
			await fs$1.access(systemNode);
		} catch {
			continue;
		}
		if (await isVersionManagedRealNodePath(systemNode, platform)) continue;
		const version = await resolveNodeVersion(systemNode, execFileImpl);
		const info = {
			path: systemNode,
			version,
			supported: isSupportedNodeVersion(version)
		};
		if (info.supported) return info;
		firstAvailable ??= info;
	}
	return firstAvailable;
}
function renderSystemNodeWarning(systemNode, selectedNodePath) {
	if (!systemNode || systemNode.supported) return null;
	const versionLabel = systemNode.version ?? "unknown";
	const selectedLabel = selectedNodePath ? ` Using ${selectedNodePath} for the daemon.` : "";
	return `System Node ${versionLabel} at ${systemNode.path} is below the required Node 22.14+.${selectedLabel} Install Node 24 (recommended) or Node 22 LTS from nodejs.org or Homebrew.`;
}
async function resolvePreferredNodePath(params) {
	if (params.runtime !== "node") return;
	const platform = params.platform ?? process.platform;
	const currentExecPath = params.execPath ?? process.execPath;
	const execFileImpl = params.execFile ?? execFileAsync;
	if (currentExecPath && isNodeExecPath(currentExecPath, platform)) {
		if (isSupportedNodeVersion(await resolveNodeVersion(currentExecPath, execFileImpl))) {
			const stableCurrentPath = await resolveStableNodePath(currentExecPath);
			if (!isVersionManagedNodePath(currentExecPath, platform)) return stableCurrentPath;
			const systemNode = await resolveSystemNodeInfo({
				env: params.env,
				platform,
				execFile: execFileImpl
			});
			if (systemNode?.supported) return systemNode.path;
			return stableCurrentPath;
		}
	}
	const systemNode = await resolveSystemNodeInfo(params);
	if (!systemNode?.supported) return;
	return systemNode.path;
}
//#endregion
export { resolveSystemNodeInfo as a, normalizeServicePathEntry as c, buildServiceEnvironment as d, getMinimalServicePathPartsFromEnv as f, resolvePreferredNodePath as i, SERVICE_PROXY_ENV_KEYS as l, isVersionManagedNodePath as n, resolveSystemNodePath as o, renderSystemNodeWarning as r, isNonMinimalServicePathEntry as s, isSystemNodePath as t, buildNodeServiceEnvironment as u };
