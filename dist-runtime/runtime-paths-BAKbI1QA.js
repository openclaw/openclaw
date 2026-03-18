import { n as VERSION } from "./version-Dubp0iGu.js";
import { _ as resolveNodeWindowsTaskName, a as NODE_SERVICE_KIND, f as resolveGatewaySystemdServiceName, g as resolveNodeSystemdServiceName, h as resolveNodeLaunchAgentLabel, l as resolveGatewayLaunchAgentLabel, n as GATEWAY_SERVICE_KIND, o as NODE_SERVICE_MARKER, p as resolveGatewayWindowsTaskName, r as GATEWAY_SERVICE_MARKER, s as NODE_WINDOWS_TASK_SCRIPT_NAME } from "./constants-C8ub4F0Y.js";
import { n as isSupportedNodeVersion } from "./runtime-guard-BeaHeRr7.js";
import path from "node:path";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import fs from "node:fs/promises";
//#region src/daemon/service-env.ts
const SERVICE_PROXY_ENV_KEYS = [
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
	const out = {};
	for (const key of SERVICE_PROXY_ENV_KEYS) {
		const value = env[key];
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		out[key] = trimmed;
	}
	return out;
}
function addNonEmptyDir(dirs, dir) {
	if (dir) dirs.push(dir);
}
function appendSubdir(base, subdir) {
	if (!base) return;
	return base.endsWith(`/${subdir}`) ? base : path.posix.join(base, subdir);
}
function addCommonUserBinDirs(dirs, home) {
	dirs.push(`${home}/.local/bin`);
	dirs.push(`${home}/.npm-global/bin`);
	dirs.push(`${home}/bin`);
	dirs.push(`${home}/.volta/bin`);
	dirs.push(`${home}/.asdf/shims`);
	dirs.push(`${home}/.bun/bin`);
}
function addCommonEnvConfiguredBinDirs(dirs, env) {
	addNonEmptyDir(dirs, env?.PNPM_HOME);
	addNonEmptyDir(dirs, appendSubdir(env?.NPM_CONFIG_PREFIX, "bin"));
	addNonEmptyDir(dirs, appendSubdir(env?.BUN_INSTALL, "bin"));
	addNonEmptyDir(dirs, appendSubdir(env?.VOLTA_HOME, "bin"));
	addNonEmptyDir(dirs, appendSubdir(env?.ASDF_DATA_DIR, "shims"));
}
function resolveSystemPathDirs(platform) {
	if (platform === "darwin") return [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin"
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
function resolveDarwinUserBinDirs(home, env) {
	if (!home) return [];
	const dirs = [];
	addCommonEnvConfiguredBinDirs(dirs, env);
	addNonEmptyDir(dirs, env?.NVM_DIR);
	addNonEmptyDir(dirs, appendSubdir(env?.FNM_DIR, "aliases/default/bin"));
	addCommonUserBinDirs(dirs, home);
	dirs.push(`${home}/Library/Application Support/fnm/aliases/default/bin`);
	dirs.push(`${home}/.fnm/aliases/default/bin`);
	dirs.push(`${home}/Library/pnpm`);
	dirs.push(`${home}/.local/share/pnpm`);
	return dirs;
}
/**
* Resolve common user bin directories for Linux.
* These are paths where npm global installs and node version managers typically place binaries.
*/
function resolveLinuxUserBinDirs(home, env) {
	if (!home) return [];
	const dirs = [];
	addCommonEnvConfiguredBinDirs(dirs, env);
	addNonEmptyDir(dirs, appendSubdir(env?.NVM_DIR, "current/bin"));
	addNonEmptyDir(dirs, appendSubdir(env?.FNM_DIR, "current/bin"));
	addCommonUserBinDirs(dirs, home);
	dirs.push(`${home}/.nvm/current/bin`);
	dirs.push(`${home}/.fnm/current/bin`);
	dirs.push(`${home}/.local/share/pnpm`);
	return dirs;
}
function getMinimalServicePathParts(options = {}) {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") return [];
	const parts = [];
	const extraDirs = options.extraDirs ?? [];
	const systemDirs = resolveSystemPathDirs(platform);
	const userDirs = platform === "linux" ? resolveLinuxUserBinDirs(options.home, options.env) : platform === "darwin" ? resolveDarwinUserBinDirs(options.home, options.env) : [];
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
	const { env, port, launchdLabel } = params;
	const platform = params.platform ?? process.platform;
	const sharedEnv = resolveSharedServiceEnvironmentFields(env, platform);
	const profile = env.OPENCLAW_PROFILE;
	const resolvedLaunchdLabel = launchdLabel || (platform === "darwin" ? resolveGatewayLaunchAgentLabel(profile) : void 0);
	const systemdUnit = `${resolveGatewaySystemdServiceName(profile)}.service`;
	return {
		...buildCommonServiceEnvironment(env, sharedEnv),
		OPENCLAW_PROFILE: profile,
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
	const { env } = params;
	const sharedEnv = resolveSharedServiceEnvironmentFields(env, params.platform ?? process.platform);
	const gatewayToken = env.OPENCLAW_GATEWAY_TOKEN?.trim() || env.CLAWDBOT_GATEWAY_TOKEN?.trim() || void 0;
	return {
		...buildCommonServiceEnvironment(env, sharedEnv),
		OPENCLAW_GATEWAY_TOKEN: gatewayToken,
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
		...sharedEnv.proxyEnv,
		NODE_EXTRA_CA_CERTS: sharedEnv.nodeCaCerts,
		NODE_USE_SYSTEM_CA: sharedEnv.nodeUseSystemCa,
		OPENCLAW_STATE_DIR: sharedEnv.stateDir,
		OPENCLAW_CONFIG_PATH: sharedEnv.configPath
	};
	if (sharedEnv.minimalPath) serviceEnv.PATH = sharedEnv.minimalPath;
	return serviceEnv;
}
function resolveSharedServiceEnvironmentFields(env, platform) {
	const stateDir = env.OPENCLAW_STATE_DIR;
	const configPath = env.OPENCLAW_CONFIG_PATH;
	const tmpDir = env.TMPDIR?.trim() || os.tmpdir();
	const proxyEnv = readServiceProxyEnvironment(env);
	const nodeCaCerts = env.NODE_EXTRA_CA_CERTS ?? (platform === "darwin" ? "/etc/ssl/cert.pem" : void 0);
	const nodeUseSystemCa = env.NODE_USE_SYSTEM_CA ?? (platform === "darwin" ? "1" : void 0);
	return {
		stateDir,
		configPath,
		tmpDir,
		minimalPath: platform === "win32" ? void 0 : buildMinimalServicePath({
			env,
			platform
		}),
		proxyEnv,
		nodeCaCerts,
		nodeUseSystemCa
	};
}
//#endregion
//#region src/infra/stable-node-path.ts
/**
* Homebrew Cellar paths (e.g. /opt/homebrew/Cellar/node/25.7.0/bin/node)
* break when Homebrew upgrades Node and removes the old version directory.
* Resolve these to a stable Homebrew-managed path that survives upgrades:
*   - Default formula "node":  <prefix>/opt/node/bin/node  or  <prefix>/bin/node
*   - Versioned formula "node@22":  <prefix>/opt/node@22/bin/node  (keg-only)
*/
async function resolveStableNodePath(nodePath) {
	const cellarMatch = nodePath.match(/^(.+?)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/);
	if (!cellarMatch) return nodePath;
	const prefix = cellarMatch[1];
	const formula = cellarMatch[2];
	const pathModule = nodePath.includes("\\") ? path.win32 : path.posix;
	const optPath = pathModule.join(prefix, "opt", formula, "bin", "node");
	try {
		await fs.access(optPath);
		return optPath;
	} catch {}
	if (formula === "node") {
		const binPath = pathModule.join(prefix, "bin", "node");
		try {
			await fs.access(binPath);
			return binPath;
		} catch {}
	}
	return nodePath;
}
//#endregion
//#region src/daemon/runtime-paths.ts
const VERSION_MANAGER_MARKERS = [
	"/.nvm/",
	"/.fnm/",
	"/.volta/",
	"/.asdf/",
	"/.n/",
	"/.nodenv/",
	"/.nodebrew/",
	"/nvs/"
];
function getPathModule(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}
function isNodeExecPath(execPath, platform) {
	const base = getPathModule(platform).basename(execPath).toLowerCase();
	return base === "node" || base === "node.exe";
}
function normalizeForCompare(input, platform) {
	const normalized = getPathModule(platform).normalize(input).replaceAll("\\", "/");
	if (platform === "win32") return normalized.toLowerCase();
	return normalized;
}
function buildSystemNodeCandidates(env, platform) {
	if (platform === "darwin") return [
		"/opt/homebrew/bin/node",
		"/usr/local/bin/node",
		"/usr/bin/node"
	];
	if (platform === "linux") return ["/usr/local/bin/node", "/usr/bin/node"];
	if (platform === "win32") {
		const pathModule = getPathModule(platform);
		const programFiles = env.ProgramFiles ?? "C:\\Program Files";
		const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		return [pathModule.join(programFiles, "nodejs", "node.exe"), pathModule.join(programFilesX86, "nodejs", "node.exe")];
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
function isVersionManagedNodePath(nodePath, platform = process.platform) {
	const normalized = normalizeForCompare(nodePath, platform);
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
		await fs.access(candidate);
		return candidate;
	} catch {}
	return null;
}
async function resolveSystemNodeInfo(params) {
	const systemNode = await resolveSystemNodePath(params.env ?? process.env, params.platform ?? process.platform);
	if (!systemNode) return null;
	const version = await resolveNodeVersion(systemNode, params.execFile ?? execFileAsync);
	return {
		path: systemNode,
		version,
		supported: isSupportedNodeVersion(version)
	};
}
function renderSystemNodeWarning(systemNode, selectedNodePath) {
	if (!systemNode || systemNode.supported) return null;
	const versionLabel = systemNode.version ?? "unknown";
	const selectedLabel = selectedNodePath ? ` Using ${selectedNodePath} for the daemon.` : "";
	return `System Node ${versionLabel} at ${systemNode.path} is below the required Node 22.16+.${selectedLabel} Install Node 24 (recommended) or Node 22 LTS from nodejs.org or Homebrew.`;
}
async function resolvePreferredNodePath(params) {
	if (params.runtime !== "node") return;
	const platform = params.platform ?? process.platform;
	const currentExecPath = params.execPath ?? process.execPath;
	if (currentExecPath && isNodeExecPath(currentExecPath, platform)) {
		if (isSupportedNodeVersion(await resolveNodeVersion(currentExecPath, params.execFile ?? execFileAsync))) return resolveStableNodePath(currentExecPath);
	}
	const systemNode = await resolveSystemNodeInfo(params);
	if (!systemNode?.supported) return;
	return systemNode.path;
}
//#endregion
export { resolveSystemNodeInfo as a, buildNodeServiceEnvironment as c, resolvePreferredNodePath as i, buildServiceEnvironment as l, isVersionManagedNodePath as n, resolveSystemNodePath as o, renderSystemNodeWarning as r, resolveStableNodePath as s, isSystemNodePath as t, getMinimalServicePathPartsFromEnv as u };
