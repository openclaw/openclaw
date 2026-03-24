import "./github-copilot-token-DIMBOSWC.js";
import { a as resolveGatewayPort, l as resolveStateDir, o as resolveIsNixMode, r as resolveConfigPath } from "./paths-CgQ-5xPU.js";
import { A as shortenHomePath, G as theme, U as colorize, W as isRich, et as isBunRuntime, j as sleep, l as defaultRuntime, q as getResolvedLoggerSettings, tt as isNodeRuntime } from "./logger-C9jPgLFF.js";
import { $i as hasConfiguredSecretInput, Dn as GatewayClient, E as resolveControlUiLinks, Ei as formatPortDiagnostics, En as READ_SCOPE, Gi as readGatewayTokenEnv, Hi as resolveGatewayAuth, Ji as pickPrimaryTailnetIPv4, Ki as trimToUndefined, Ni as formatErrorMessage, On as loadGatewayTlsRuntime, Or as parseStrictInteger, Sa as formatDocsLink, Sn as killProcessTree, T as randomToken, Ti as classifyPortListener, Tn as resolveGatewayCredentialsWithSecretInputs, Ui as isGatewaySecretRefUnavailableError, Vi as hasAmbiguousGatewayAuthModeConfig, Vn as isRestartEnabled, Wi as resolveGatewayDriftCheckCredentialsFromConfig, Xi as resolveSecretRefValues, Zi as secretRefKey, _a as resolveGatewaySystemdServiceName, _n as parseCmdSetAssignment, ba as collectConfigServiceEnvVars, bn as findGatewayPidsOnPortSync, da as GATEWAY_LAUNCH_AGENT_LABEL, ea as resolveSecretInputRef, fa as GATEWAY_SERVICE_KIND, g as withProgress, ga as resolveGatewayServiceDescription, gn as assertNoCmdLineBreak, ha as resolveGatewayProfileSuffix, hn as quoteCmdScriptArg, i as readConfigFileSnapshot, kr as parseStrictPositiveInteger, la as sanitizeTerminalText, ma as resolveGatewayLaunchAgentLabel, mi as GATEWAY_CLIENT_NAMES, mn as parseCmdScriptCommandLine, pa as GATEWAY_SERVICE_MARKER, pi as GATEWAY_CLIENT_MODES, qi as resolveGatewayBindHost, r as readBestEffortConfig, s as writeConfigFile, t as createConfigIO, ua as VERSION, va as resolveGatewayWindowsTaskName, vn as renderCmdSetAssignment, wi as inspectPortUsage, wn as callGateway, xa as formatCliCommand, ya as resolveLegacyGatewayLaunchAgentLabels, yn as splitArgsPreservingQuotes } from "./config-BMm_LBPc.js";
import { Vt as runCommandWithTimeout } from "./query-expansion-D0B6X4Uh.js";
import { i as isWSLEnv, r as isWSL } from "./fetch-BF3I-vXt.js";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import "node:process";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
//#region src/cli/command-options.ts
function getOptionSource(command, name) {
	if (typeof command.getOptionValueSource !== "function") return;
	return command.getOptionValueSource(name);
}
const MAX_INHERIT_DEPTH = 2;
function inheritOptionFromParent(command, name) {
	if (!command) return;
	const childSource = getOptionSource(command, name);
	if (childSource && childSource !== "default") return;
	let depth = 0;
	let ancestor = command.parent;
	while (ancestor && depth < MAX_INHERIT_DEPTH) {
		const source = getOptionSource(ancestor, name);
		if (source && source !== "default") return ancestor.opts()[name];
		depth += 1;
		ancestor = ancestor.parent;
	}
}
//#endregion
//#region src/daemon/program-args.ts
async function resolveCliEntrypointPathForService() {
	const argv1 = process.argv[1];
	if (!argv1) throw new Error("Unable to resolve CLI entrypoint path");
	const normalized = path.resolve(argv1);
	const resolvedPath = await resolveRealpathSafe(normalized);
	if (/[/\\]dist[/\\].+\.(cjs|js|mjs)$/.test(resolvedPath)) {
		await fs.access(resolvedPath);
		if (/[/\\]dist[/\\].+\.(cjs|js|mjs)$/.test(normalized) && normalized !== resolvedPath) try {
			await fs.access(normalized);
			return normalized;
		} catch {}
		return resolvedPath;
	}
	const distCandidates = buildDistCandidates(resolvedPath, normalized);
	for (const candidate of distCandidates) try {
		await fs.access(candidate);
		return candidate;
	} catch {}
	throw new Error(`Cannot find built CLI at ${distCandidates.join(" or ")}. Run "pnpm build" first, or use dev mode.`);
}
async function resolveRealpathSafe(inputPath) {
	try {
		return await fs.realpath(inputPath);
	} catch {
		return inputPath;
	}
}
function buildDistCandidates(...inputs) {
	const candidates = [];
	const seen = /* @__PURE__ */ new Set();
	for (const inputPath of inputs) {
		if (!inputPath) continue;
		const baseDir = path.dirname(inputPath);
		appendDistCandidates(candidates, seen, path.resolve(baseDir, ".."));
		appendDistCandidates(candidates, seen, baseDir);
		appendNodeModulesBinCandidates(candidates, seen, inputPath);
	}
	return candidates;
}
function appendDistCandidates(candidates, seen, baseDir) {
	const distDir = path.resolve(baseDir, "dist");
	const distEntries = [
		path.join(distDir, "index.js"),
		path.join(distDir, "index.mjs"),
		path.join(distDir, "entry.js"),
		path.join(distDir, "entry.mjs")
	];
	for (const entry of distEntries) {
		if (seen.has(entry)) continue;
		seen.add(entry);
		candidates.push(entry);
	}
}
function appendNodeModulesBinCandidates(candidates, seen, inputPath) {
	const parts = inputPath.split(path.sep);
	const binIndex = parts.lastIndexOf(".bin");
	if (binIndex <= 0) return;
	if (parts[binIndex - 1] !== "node_modules") return;
	const binName = path.basename(inputPath);
	const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
	appendDistCandidates(candidates, seen, path.join(nodeModulesDir, binName));
}
function resolveRepoRootForDev() {
	const argv1 = process.argv[1];
	if (!argv1) throw new Error("Unable to resolve repo root");
	const parts = path.resolve(argv1).split(path.sep);
	const srcIndex = parts.lastIndexOf("src");
	if (srcIndex === -1) throw new Error("Dev mode requires running from repo (src/index.ts)");
	return parts.slice(0, srcIndex).join(path.sep);
}
async function resolveBunPath() {
	return await resolveBinaryPath("bun");
}
async function resolveNodePath() {
	return await resolveBinaryPath("node");
}
async function resolveBinaryPath(binary) {
	const { execFileSync } = await import("node:child_process");
	const cmd = process.platform === "win32" ? "where" : "which";
	try {
		const resolved = execFileSync(cmd, [binary], { encoding: "utf8" }).trim().split(/\r?\n/)[0]?.trim();
		if (!resolved) throw new Error("empty");
		await fs.access(resolved);
		return resolved;
	} catch {
		if (binary === "bun") throw new Error("Bun not found in PATH. Install bun: https://bun.sh");
		throw new Error("Node not found in PATH. Install Node 24 (recommended) or Node 22 LTS (22.16+).");
	}
}
async function resolveCliProgramArguments(params) {
	const execPath = process.execPath;
	const runtime = params.runtime ?? "auto";
	if (runtime === "node") return { programArguments: [
		params.nodePath ?? (isNodeRuntime(execPath) ? execPath : await resolveNodePath()),
		await resolveCliEntrypointPathForService(),
		...params.args
	] };
	if (runtime === "bun") {
		if (params.dev) {
			const repoRoot = resolveRepoRootForDev();
			const devCliPath = path.join(repoRoot, "src", "index.ts");
			await fs.access(devCliPath);
			return {
				programArguments: [
					isBunRuntime(execPath) ? execPath : await resolveBunPath(),
					devCliPath,
					...params.args
				],
				workingDirectory: repoRoot
			};
		}
		return { programArguments: [
			isBunRuntime(execPath) ? execPath : await resolveBunPath(),
			await resolveCliEntrypointPathForService(),
			...params.args
		] };
	}
	if (!params.dev) try {
		return { programArguments: [
			execPath,
			await resolveCliEntrypointPathForService(),
			...params.args
		] };
	} catch (error) {
		if (!isNodeRuntime(execPath)) return { programArguments: [execPath, ...params.args] };
		throw error;
	}
	const repoRoot = resolveRepoRootForDev();
	const devCliPath = path.join(repoRoot, "src", "index.ts");
	await fs.access(devCliPath);
	if (isBunRuntime(execPath)) return {
		programArguments: [
			execPath,
			devCliPath,
			...params.args
		],
		workingDirectory: repoRoot
	};
	return {
		programArguments: [
			await resolveBunPath(),
			devCliPath,
			...params.args
		],
		workingDirectory: repoRoot
	};
}
async function resolveGatewayProgramArguments(params) {
	return resolveCliProgramArguments({
		args: [
			"gateway",
			"--port",
			String(params.port)
		],
		dev: params.dev,
		runtime: params.runtime,
		nodePath: params.nodePath
	});
}
//#endregion
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
//#region src/infra/runtime-guard.ts
const MIN_NODE = {
	major: 22,
	minor: 16,
	patch: 0
};
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;
function parseSemver(version) {
	if (!version) return null;
	const match = version.match(SEMVER_RE);
	if (!match) return null;
	const [, major, minor, patch] = match;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10)
	};
}
function isAtLeast(version, minimum) {
	if (!version) return false;
	if (version.major !== minimum.major) return version.major > minimum.major;
	if (version.minor !== minimum.minor) return version.minor > minimum.minor;
	return version.patch >= minimum.patch;
}
function isSupportedNodeVersion(version) {
	return isAtLeast(parseSemver(version), MIN_NODE);
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
	const cellarMatch = nodePath.match(/^(.+?)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
	if (!cellarMatch) return nodePath;
	const prefix = cellarMatch[1];
	const formula = cellarMatch[2];
	const optPath = `${prefix}/opt/${formula}/bin/node`;
	try {
		await fs.access(optPath);
		return optPath;
	} catch {}
	if (formula === "node") {
		const binPath = `${prefix}/bin/node`;
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
function getPathModule$1(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}
function isNodeExecPath(execPath, platform) {
	const base = getPathModule$1(platform).basename(execPath).toLowerCase();
	return base === "node" || base === "node.exe";
}
function normalizeForCompare(input, platform) {
	const normalized = getPathModule$1(platform).normalize(input).replaceAll("\\", "/");
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
		const pathModule = getPathModule$1(platform);
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
//#region src/commands/daemon-install-runtime-warning.ts
async function emitNodeRuntimeWarning(params) {
	if (params.runtime !== "node") return;
	const warning = renderSystemNodeWarning(await resolveSystemNodeInfo({ env: params.env }), params.nodeProgram);
	if (warning) params.warn?.(warning, params.title);
}
//#endregion
//#region src/commands/daemon-install-plan.shared.ts
function resolveGatewayDevMode(argv = process.argv) {
	const normalizedEntry = argv[1]?.replaceAll("\\", "/");
	return Boolean(normalizedEntry?.includes("/src/") && normalizedEntry.endsWith(".ts"));
}
async function resolveDaemonInstallRuntimeInputs(params) {
	return {
		devMode: params.devMode ?? resolveGatewayDevMode(),
		nodePath: params.nodePath ?? await resolvePreferredNodePath({
			env: params.env,
			runtime: params.runtime
		})
	};
}
async function emitDaemonInstallRuntimeWarning(params) {
	await emitNodeRuntimeWarning({
		env: params.env,
		runtime: params.runtime,
		nodeProgram: params.programArguments[0],
		warn: params.warn,
		title: params.title
	});
}
//#endregion
//#region src/commands/daemon-install-helpers.ts
async function buildGatewayInstallPlan(params) {
	const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
		env: params.env,
		runtime: params.runtime,
		devMode: params.devMode,
		nodePath: params.nodePath
	});
	const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
		port: params.port,
		dev: devMode,
		runtime: params.runtime,
		nodePath
	});
	await emitDaemonInstallRuntimeWarning({
		env: params.env,
		runtime: params.runtime,
		programArguments,
		warn: params.warn,
		title: "Gateway runtime"
	});
	const serviceEnvironment = buildServiceEnvironment({
		env: params.env,
		port: params.port,
		launchdLabel: process.platform === "darwin" ? resolveGatewayLaunchAgentLabel(params.env.OPENCLAW_PROFILE) : void 0
	});
	const environment = { ...collectConfigServiceEnvVars(params.config) };
	Object.assign(environment, serviceEnvironment);
	return {
		programArguments,
		workingDirectory,
		environment
	};
}
//#endregion
//#region src/commands/daemon-runtime.ts
const DEFAULT_GATEWAY_DAEMON_RUNTIME = "node";
function isGatewayDaemonRuntime(value) {
	return value === "node" || value === "bun";
}
//#endregion
//#region src/gateway/auth-install-policy.ts
function shouldRequireGatewayTokenForInstall(cfg, _env) {
	const mode = cfg.gateway?.auth?.mode;
	if (mode === "token") return true;
	if (mode === "password" || mode === "none" || mode === "trusted-proxy") return false;
	if (hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults)) return false;
	const configServiceEnv = collectConfigServiceEnvVars(cfg);
	if (Boolean(configServiceEnv.OPENCLAW_GATEWAY_PASSWORD?.trim() || configServiceEnv.CLAWDBOT_GATEWAY_PASSWORD?.trim())) return false;
	return true;
}
//#endregion
//#region src/commands/gateway-install-token.ts
function formatAmbiguousGatewayAuthModeReason() {
	return ["gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset.", `Set ${formatCliCommand("openclaw config set gateway.auth.mode token")} or ${formatCliCommand("openclaw config set gateway.auth.mode password")}.`].join(" ");
}
async function resolveGatewayInstallToken(options) {
	const cfg = options.config;
	const warnings = [];
	const tokenRef = resolveSecretInputRef({
		value: cfg.gateway?.auth?.token,
		defaults: cfg.secrets?.defaults
	}).ref;
	const tokenRefConfigured = Boolean(tokenRef);
	const configToken = tokenRef || typeof cfg.gateway?.auth?.token !== "string" ? void 0 : cfg.gateway.auth.token.trim() || void 0;
	const explicitToken = options.explicitToken?.trim() || void 0;
	const envToken = readGatewayTokenEnv(options.env);
	if (hasAmbiguousGatewayAuthModeConfig(cfg)) return {
		token: void 0,
		tokenRefConfigured,
		unavailableReason: formatAmbiguousGatewayAuthModeReason(),
		warnings
	};
	const resolvedAuth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off"
	});
	const needsToken = shouldRequireGatewayTokenForInstall(cfg, options.env) && !resolvedAuth.allowTailscale;
	let token = explicitToken || configToken || (tokenRef ? void 0 : envToken);
	let unavailableReason;
	if (tokenRef && !token && needsToken) try {
		const value = (await resolveSecretRefValues([tokenRef], {
			config: cfg,
			env: options.env
		})).get(secretRefKey(tokenRef));
		if (typeof value !== "string" || value.trim().length === 0) throw new Error("gateway.auth.token resolved to an empty or non-string value.");
		warnings.push("gateway.auth.token is SecretRef-managed; install will not persist a resolved token in service environment. Ensure the SecretRef is resolvable in the daemon runtime context.");
	} catch (err) {
		unavailableReason = `gateway.auth.token SecretRef is configured but unresolved (${String(err)}).`;
	}
	const allowAutoGenerate = options.autoGenerateWhenMissing ?? false;
	const persistGeneratedToken = options.persistGeneratedToken ?? false;
	if (!token && needsToken && !tokenRef && allowAutoGenerate) {
		token = randomToken();
		warnings.push(persistGeneratedToken ? "No gateway token found. Auto-generated one and saving to config." : "No gateway token found. Auto-generated one for this run without saving to config.");
		if (persistGeneratedToken) try {
			const snapshot = await readConfigFileSnapshot();
			if (snapshot.exists && !snapshot.valid) warnings.push("Warning: config file exists but is invalid; skipping token persistence.");
			else {
				const baseConfig = snapshot.exists ? snapshot.config : {};
				const existingTokenRef = resolveSecretInputRef({
					value: baseConfig.gateway?.auth?.token,
					defaults: baseConfig.secrets?.defaults
				}).ref;
				const baseConfigToken = existingTokenRef || typeof baseConfig.gateway?.auth?.token !== "string" ? void 0 : baseConfig.gateway.auth.token.trim() || void 0;
				if (!existingTokenRef && !baseConfigToken) await writeConfigFile({
					...baseConfig,
					gateway: {
						...baseConfig.gateway,
						auth: {
							...baseConfig.gateway?.auth,
							mode: baseConfig.gateway?.auth?.mode ?? "token",
							token
						}
					}
				});
				else if (baseConfigToken) token = baseConfigToken;
				else {
					token = void 0;
					warnings.push("Warning: gateway.auth.token is SecretRef-managed; skipping plaintext token persistence.");
				}
			}
		} catch (err) {
			warnings.push(`Warning: could not persist token to config: ${String(err)}`);
		}
	}
	return {
		token,
		tokenRefConfigured,
		unavailableReason,
		warnings
	};
}
//#endregion
//#region src/daemon/exec-file.ts
async function execFileUtf8(command, args, options = {}) {
	return await new Promise((resolve) => {
		execFile(command, args, {
			...options,
			encoding: "utf8"
		}, (error, stdout, stderr) => {
			if (!error) {
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code: 0
				});
				return;
			}
			const e = error;
			const stderrText = String(stderr ?? "");
			resolve({
				stdout: String(stdout ?? ""),
				stderr: stderrText || (typeof e.message === "string" ? e.message : typeof error === "string" ? error : ""),
				code: typeof e.code === "number" ? e.code : 1
			});
		});
	});
}
const plistEscape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
const plistUnescape = (value) => value.replaceAll("&apos;", "'").replaceAll("&quot;", "\"").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const renderEnvDict = (env) => {
	if (!env) return "";
	const entries = Object.entries(env).filter(([, value]) => typeof value === "string" && value.trim());
	if (entries.length === 0) return "";
	return `\n    <key>EnvironmentVariables</key>\n    <dict>${entries.map(([key, value]) => `\n    <key>${plistEscape(key)}</key>\n    <string>${plistEscape(value?.trim() ?? "")}</string>`).join("")}\n    </dict>`;
};
async function readLaunchAgentProgramArgumentsFromFile(plistPath) {
	try {
		const plist = await fs.readFile(plistPath, "utf8");
		const programMatch = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i);
		if (!programMatch) return null;
		const args = Array.from(programMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/gi)).map((match) => plistUnescape(match[1] ?? "").trim());
		const workingDirMatch = plist.match(/<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/i);
		const workingDirectory = workingDirMatch ? plistUnescape(workingDirMatch[1] ?? "").trim() : "";
		const envMatch = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/i);
		const environment = {};
		if (envMatch) for (const pair of envMatch[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gi)) {
			const key = plistUnescape(pair[1] ?? "").trim();
			if (!key) continue;
			environment[key] = plistUnescape(pair[2] ?? "").trim();
		}
		return {
			programArguments: args.filter(Boolean),
			...workingDirectory ? { workingDirectory } : {},
			...Object.keys(environment).length > 0 ? { environment } : {},
			sourcePath: plistPath
		};
	} catch {
		return null;
	}
}
function buildLaunchAgentPlist$1({ label, comment, programArguments, workingDirectory, stdoutPath, stderrPath, environment }) {
	const argsXml = programArguments.map((arg) => `\n      <string>${plistEscape(arg)}</string>`).join("");
	const workingDirXml = workingDirectory ? `\n    <key>WorkingDirectory</key>\n    <string>${plistEscape(workingDirectory)}</string>` : "";
	const commentXml = comment?.trim() ? `\n    <key>Comment</key>\n    <string>${plistEscape(comment.trim())}</string>` : "";
	const envXml = renderEnvDict(environment);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${plistEscape(label)}</string>\n    ${commentXml}\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n    <key>ThrottleInterval</key>\n    <integer>1</integer>\n    <key>Umask</key>\n    <integer>63</integer>\n    <key>ProgramArguments</key>\n    <array>${argsXml}\n    </array>\n    ${workingDirXml}\n    <key>StandardOutPath</key>\n    <string>${plistEscape(stdoutPath)}</string>\n    <key>StandardErrorPath</key>\n    <string>${plistEscape(stderrPath)}</string>${envXml}\n  </dict>\n</plist>\n`;
}
//#endregion
//#region src/daemon/launchd-restart-handoff.ts
function resolveGuiDomain$1() {
	if (typeof process.getuid !== "function") return "gui/501";
	return `gui/${process.getuid()}`;
}
function resolveLaunchAgentLabel$1(env) {
	const envLabel = env?.OPENCLAW_LAUNCHD_LABEL?.trim();
	if (envLabel) return envLabel;
	return resolveGatewayLaunchAgentLabel(env?.OPENCLAW_PROFILE);
}
function resolveLaunchdRestartTarget(env = process.env) {
	const domain = resolveGuiDomain$1();
	const label = resolveLaunchAgentLabel$1(env);
	const home = env.HOME?.trim() || os.homedir();
	return {
		domain,
		label,
		plistPath: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
		serviceTarget: `${domain}/${label}`
	};
}
function isCurrentProcessLaunchdServiceLabel(label, env = process.env) {
	const launchdLabel = env.LAUNCH_JOB_LABEL?.trim() || env.LAUNCH_JOB_NAME?.trim() || env.XPC_SERVICE_NAME?.trim();
	if (launchdLabel) return launchdLabel === label;
	const configuredLabel = env.OPENCLAW_LAUNCHD_LABEL?.trim();
	return Boolean(configuredLabel && configuredLabel === label);
}
function buildLaunchdRestartScript(mode) {
	const waitForCallerPid = `wait_pid="$4"
if [ -n "$wait_pid" ] && [ "$wait_pid" -gt 1 ] 2>/dev/null; then
  while kill -0 "$wait_pid" >/dev/null 2>&1; do
    sleep 0.1
  done
fi
`;
	if (mode === "kickstart") return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
if ! launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  fi
fi
`;
	return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
if ! launchctl start "$service_target" >/dev/null 2>&1; then
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    launchctl start "$service_target" >/dev/null 2>&1 || launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  else
    launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  fi
fi
`;
}
function scheduleDetachedLaunchdRestartHandoff(params) {
	const target = resolveLaunchdRestartTarget(params.env);
	const waitForPid = typeof params.waitForPid === "number" && Number.isFinite(params.waitForPid) ? Math.floor(params.waitForPid) : 0;
	try {
		const child = spawn("/bin/sh", [
			"-c",
			buildLaunchdRestartScript(params.mode),
			"openclaw-launchd-restart-handoff",
			target.serviceTarget,
			target.domain,
			target.plistPath,
			String(waitForPid)
		], {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				...params.env
			}
		});
		child.unref();
		return {
			ok: true,
			pid: child.pid ?? void 0
		};
	} catch (err) {
		return {
			ok: false,
			detail: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
//#region src/daemon/output.ts
const toPosixPath = (value) => value.replace(/\\/g, "/");
function formatLine(label, value) {
	const rich = isRich();
	return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
}
function writeFormattedLines(stdout, lines, opts) {
	if (opts?.leadingBlankLine) stdout.write("\n");
	for (const line of lines) stdout.write(`${formatLine(line.label, line.value)}\n`);
}
//#endregion
//#region src/daemon/paths.ts
const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;
function resolveHomeDir$1(env) {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim();
	if (!home) throw new Error("Missing HOME");
	return home;
}
function resolveUserPathWithHome(input, home) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		if (!home) throw new Error("Missing HOME");
		const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
		return path.resolve(expanded);
	}
	if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) return trimmed;
	return path.resolve(trimmed);
}
function resolveGatewayStateDir(env) {
	const override = env.OPENCLAW_STATE_DIR?.trim();
	if (override) return resolveUserPathWithHome(override, override.startsWith("~") ? resolveHomeDir$1(env) : void 0);
	const home = resolveHomeDir$1(env);
	const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
	return path.join(home, `.openclaw${suffix}`);
}
//#endregion
//#region src/daemon/runtime-parse.ts
function parseKeyValueOutput(output, separator) {
	const entries = {};
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const idx = line.indexOf(separator);
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		if (!key) continue;
		entries[key] = line.slice(idx + separator.length).trim();
	}
	return entries;
}
//#endregion
//#region src/daemon/launchd.ts
const LAUNCH_AGENT_DIR_MODE = 493;
const LAUNCH_AGENT_PLIST_MODE = 420;
function resolveLaunchAgentLabel(args) {
	const envLabel = args?.env?.OPENCLAW_LAUNCHD_LABEL?.trim();
	if (envLabel) return envLabel;
	return resolveGatewayLaunchAgentLabel(args?.env?.OPENCLAW_PROFILE);
}
function resolveLaunchAgentPlistPathForLabel(env, label) {
	const home = toPosixPath(resolveHomeDir$1(env));
	return path.posix.join(home, "Library", "LaunchAgents", `${label}.plist`);
}
function resolveLaunchAgentPlistPath(env) {
	return resolveLaunchAgentPlistPathForLabel(env, resolveLaunchAgentLabel({ env }));
}
function resolveGatewayLogPaths(env) {
	const stateDir = resolveGatewayStateDir(env);
	const logDir = path.join(stateDir, "logs");
	const prefix = env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";
	return {
		logDir,
		stdoutPath: path.join(logDir, `${prefix}.log`),
		stderrPath: path.join(logDir, `${prefix}.err.log`)
	};
}
async function readLaunchAgentProgramArguments(env) {
	return readLaunchAgentProgramArgumentsFromFile(resolveLaunchAgentPlistPath(env));
}
function buildLaunchAgentPlist({ label = GATEWAY_LAUNCH_AGENT_LABEL, comment, programArguments, workingDirectory, stdoutPath, stderrPath, environment }) {
	return buildLaunchAgentPlist$1({
		label,
		comment,
		programArguments,
		workingDirectory,
		stdoutPath,
		stderrPath,
		environment
	});
}
async function execLaunchctl(args) {
	const isWindows = process.platform === "win32";
	return await execFileUtf8(isWindows ? process.env.ComSpec ?? "cmd.exe" : "launchctl", isWindows ? [
		"/d",
		"/s",
		"/c",
		"launchctl",
		...args
	] : args, isWindows ? { windowsHide: true } : {});
}
function resolveGuiDomain() {
	if (typeof process.getuid !== "function") return "gui/501";
	return `gui/${process.getuid()}`;
}
async function ensureSecureDirectory(targetPath) {
	await fs.mkdir(targetPath, {
		recursive: true,
		mode: LAUNCH_AGENT_DIR_MODE
	});
	try {
		const mode = (await fs.stat(targetPath)).mode & 511;
		const tightenedMode = mode & -19;
		if (tightenedMode !== mode) await fs.chmod(targetPath, tightenedMode);
	} catch {}
}
function parseLaunchctlPrint(output) {
	const entries = parseKeyValueOutput(output, "=");
	const info = {};
	const state = entries.state;
	if (state) info.state = state;
	const pidValue = entries.pid;
	if (pidValue) {
		const pid = parseStrictPositiveInteger(pidValue);
		if (pid !== void 0) info.pid = pid;
	}
	const exitStatusValue = entries["last exit status"];
	if (exitStatusValue) {
		const status = parseStrictInteger(exitStatusValue);
		if (status !== void 0) info.lastExitStatus = status;
	}
	const exitReason = entries["last exit reason"];
	if (exitReason) info.lastExitReason = exitReason;
	return info;
}
async function isLaunchAgentLoaded(args) {
	return (await execLaunchctl(["print", `${resolveGuiDomain()}/${resolveLaunchAgentLabel({ env: args.env })}`])).code === 0;
}
async function launchAgentPlistExists(env) {
	try {
		const plistPath = resolveLaunchAgentPlistPath(env);
		await fs.access(plistPath);
		return true;
	} catch {
		return false;
	}
}
async function readLaunchAgentRuntime(env) {
	const res = await execLaunchctl(["print", `${resolveGuiDomain()}/${resolveLaunchAgentLabel({ env })}`]);
	if (res.code !== 0) return {
		status: "unknown",
		detail: (res.stderr || res.stdout).trim() || void 0,
		missingUnit: true
	};
	const parsed = parseLaunchctlPrint(res.stdout || res.stderr || "");
	const plistExists = await launchAgentPlistExists(env);
	const state = parsed.state?.toLowerCase();
	return {
		status: state === "running" || parsed.pid ? "running" : state ? "stopped" : "unknown",
		state: parsed.state,
		pid: parsed.pid,
		lastExitStatus: parsed.lastExitStatus,
		lastExitReason: parsed.lastExitReason,
		cachedLabel: !plistExists
	};
}
async function uninstallLaunchAgent({ env, stdout }) {
	const domain = resolveGuiDomain();
	const label = resolveLaunchAgentLabel({ env });
	const plistPath = resolveLaunchAgentPlistPath(env);
	await execLaunchctl([
		"bootout",
		domain,
		plistPath
	]);
	await execLaunchctl(["unload", plistPath]);
	try {
		await fs.access(plistPath);
	} catch {
		stdout.write(`LaunchAgent not found at ${plistPath}\n`);
		return;
	}
	const home = toPosixPath(resolveHomeDir$1(env));
	const trashDir = path.posix.join(home, ".Trash");
	const dest = path.join(trashDir, `${label}.plist`);
	try {
		await fs.mkdir(trashDir, { recursive: true });
		await fs.rename(plistPath, dest);
		stdout.write(`${formatLine("Moved LaunchAgent to Trash", dest)}\n`);
	} catch {
		stdout.write(`LaunchAgent remains at ${plistPath} (could not move)\n`);
	}
}
function isLaunchctlNotLoaded(res) {
	const detail = (res.stderr || res.stdout).toLowerCase();
	return detail.includes("no such process") || detail.includes("could not find service") || detail.includes("not found");
}
function isUnsupportedGuiDomain(detail) {
	const normalized = detail.toLowerCase();
	return normalized.includes("domain does not support specified action") || normalized.includes("bootstrap failed: 125");
}
async function stopLaunchAgent({ stdout, env }) {
	const domain = resolveGuiDomain();
	const label = resolveLaunchAgentLabel({ env });
	const res = await execLaunchctl(["bootout", `${domain}/${label}`]);
	if (res.code !== 0 && !isLaunchctlNotLoaded(res)) throw new Error(`launchctl bootout failed: ${res.stderr || res.stdout}`.trim());
	stdout.write(`${formatLine("Stopped LaunchAgent", `${domain}/${label}`)}\n`);
}
async function installLaunchAgent({ env, stdout, programArguments, workingDirectory, environment, description }) {
	const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
	await ensureSecureDirectory(logDir);
	const domain = resolveGuiDomain();
	const label = resolveLaunchAgentLabel({ env });
	for (const legacyLabel of resolveLegacyGatewayLaunchAgentLabels(env.OPENCLAW_PROFILE)) {
		const legacyPlistPath = resolveLaunchAgentPlistPathForLabel(env, legacyLabel);
		await execLaunchctl([
			"bootout",
			domain,
			legacyPlistPath
		]);
		await execLaunchctl(["unload", legacyPlistPath]);
		try {
			await fs.unlink(legacyPlistPath);
		} catch {}
	}
	const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
	const home = toPosixPath(resolveHomeDir$1(env));
	const libraryDir = path.posix.join(home, "Library");
	await ensureSecureDirectory(home);
	await ensureSecureDirectory(libraryDir);
	await ensureSecureDirectory(path.dirname(plistPath));
	const plist = buildLaunchAgentPlist({
		label,
		comment: resolveGatewayServiceDescription({
			env,
			environment,
			description
		}),
		programArguments,
		workingDirectory,
		stdoutPath,
		stderrPath,
		environment
	});
	await fs.writeFile(plistPath, plist, {
		encoding: "utf8",
		mode: LAUNCH_AGENT_PLIST_MODE
	});
	await fs.chmod(plistPath, LAUNCH_AGENT_PLIST_MODE).catch(() => void 0);
	await execLaunchctl([
		"bootout",
		domain,
		plistPath
	]);
	await execLaunchctl(["unload", plistPath]);
	await execLaunchctl(["enable", `${domain}/${label}`]);
	const boot = await execLaunchctl([
		"bootstrap",
		domain,
		plistPath
	]);
	if (boot.code !== 0) {
		const detail = (boot.stderr || boot.stdout).trim();
		if (isUnsupportedGuiDomain(detail)) throw new Error([
			`launchctl bootstrap failed: ${detail}`,
			`LaunchAgent install requires a logged-in macOS GUI session for this user (${domain}).`,
			"This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
			"Fix: sign in to the macOS desktop as the target user and rerun `openclaw gateway install --force`.",
			"Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway"
		].join("\n"));
		throw new Error(`launchctl bootstrap failed: ${detail}`);
	}
	await execLaunchctl([
		"kickstart",
		"-k",
		`${domain}/${label}`
	]);
	writeFormattedLines(stdout, [{
		label: "Installed LaunchAgent",
		value: plistPath
	}, {
		label: "Logs",
		value: stdoutPath
	}], { leadingBlankLine: true });
	return { plistPath };
}
async function restartLaunchAgent({ stdout, env }) {
	const serviceEnv = env ?? process.env;
	const domain = resolveGuiDomain();
	const label = resolveLaunchAgentLabel({ env: serviceEnv });
	const plistPath = resolveLaunchAgentPlistPath(serviceEnv);
	const serviceTarget = `${domain}/${label}`;
	if (isCurrentProcessLaunchdServiceLabel(label)) {
		const handoff = scheduleDetachedLaunchdRestartHandoff({
			env: serviceEnv,
			mode: "kickstart",
			waitForPid: process.pid
		});
		if (!handoff.ok) throw new Error(`launchd restart handoff failed: ${handoff.detail ?? "unknown error"}`);
		try {
			stdout.write(`${formatLine("Scheduled LaunchAgent restart", serviceTarget)}\n`);
		} catch (err) {
			if (err?.code !== "EPIPE") throw err;
		}
		return { outcome: "scheduled" };
	}
	const start = await execLaunchctl([
		"kickstart",
		"-k",
		serviceTarget
	]);
	if (start.code === 0) {
		try {
			stdout.write(`${formatLine("Restarted LaunchAgent", serviceTarget)}\n`);
		} catch (err) {
			if (err?.code !== "EPIPE") throw err;
		}
		return { outcome: "completed" };
	}
	if (!isLaunchctlNotLoaded(start)) throw new Error(`launchctl kickstart failed: ${start.stderr || start.stdout}`.trim());
	await execLaunchctl(["enable", serviceTarget]);
	const boot = await execLaunchctl([
		"bootstrap",
		domain,
		plistPath
	]);
	if (boot.code !== 0) {
		const detail = (boot.stderr || boot.stdout).trim();
		if (isUnsupportedGuiDomain(detail)) throw new Error([
			`launchctl bootstrap failed: ${detail}`,
			`LaunchAgent restart requires a logged-in macOS GUI session for this user (${domain}).`,
			"This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
			"Fix: sign in to the macOS desktop as the target user and rerun `openclaw gateway restart`.",
			"Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway"
		].join("\n"));
		throw new Error(`launchctl bootstrap failed: ${detail}`);
	}
	const retry = await execLaunchctl([
		"kickstart",
		"-k",
		serviceTarget
	]);
	if (retry.code !== 0) throw new Error(`launchctl kickstart failed: ${retry.stderr || retry.stdout}`.trim());
	try {
		stdout.write(`${formatLine("Restarted LaunchAgent", serviceTarget)}\n`);
	} catch (err) {
		if (err?.code !== "EPIPE") throw err;
	}
	return { outcome: "completed" };
}
//#endregion
//#region src/daemon/schtasks-exec.ts
const SCHTASKS_TIMEOUT_MS = 15e3;
const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 5e3;
async function execSchtasks(args) {
	const result = await runCommandWithTimeout(["schtasks", ...args], {
		timeoutMs: SCHTASKS_TIMEOUT_MS,
		noOutputTimeoutMs: SCHTASKS_NO_OUTPUT_TIMEOUT_MS
	});
	const timeoutDetail = result.termination === "timeout" ? `schtasks timed out after ${SCHTASKS_TIMEOUT_MS}ms` : result.termination === "no-output-timeout" ? `schtasks produced no output for ${SCHTASKS_NO_OUTPUT_TIMEOUT_MS}ms` : "";
	return {
		stdout: result.stdout,
		stderr: result.stderr || timeoutDetail,
		code: typeof result.code === "number" ? result.code : result.killed ? 124 : 1
	};
}
//#endregion
//#region src/daemon/schtasks.ts
function resolveTaskName(env) {
	const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
	if (override) return override;
	return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}
function shouldFallbackToStartupEntry(params) {
	return /access is denied/i.test(params.detail) || params.code === 124 || /schtasks timed out/i.test(params.detail) || /schtasks produced no output/i.test(params.detail);
}
function resolveTaskScriptPath(env) {
	const override = env.OPENCLAW_TASK_SCRIPT?.trim();
	if (override) return override;
	const scriptName = env.OPENCLAW_TASK_SCRIPT_NAME?.trim() || "gateway.cmd";
	const stateDir = resolveGatewayStateDir(env);
	return path.join(stateDir, scriptName);
}
function resolveWindowsStartupDir(env) {
	const appData = env.APPDATA?.trim();
	if (appData) return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
	const home = env.USERPROFILE?.trim() || env.HOME?.trim();
	if (!home) throw new Error("Windows startup folder unavailable: APPDATA/USERPROFILE not set");
	return path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}
function sanitizeWindowsFilename(value) {
	return value.replace(/[<>:"/\\|?*]/g, "_").replace(/\p{Cc}/gu, "_");
}
function resolveStartupEntryPath(env) {
	const taskName = resolveTaskName(env);
	return path.join(resolveWindowsStartupDir(env), `${sanitizeWindowsFilename(taskName)}.cmd`);
}
function quoteSchtasksArg(value) {
	if (!/[ \t"]/g.test(value)) return value;
	return `"${value.replace(/"/g, "\\\"")}"`;
}
function resolveTaskUser(env) {
	const username = env.USERNAME || env.USER || env.LOGNAME;
	if (!username) return null;
	if (username.includes("\\")) return username;
	const domain = env.USERDOMAIN;
	if (domain) return `${domain}\\${username}`;
	return username;
}
async function readScheduledTaskCommand(env) {
	const scriptPath = resolveTaskScriptPath(env);
	try {
		const content = await fs.readFile(scriptPath, "utf8");
		let workingDirectory = "";
		let commandLine = "";
		const environment = {};
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line) continue;
			const lower = line.toLowerCase();
			if (line.startsWith("@echo")) continue;
			if (lower.startsWith("rem ")) continue;
			if (lower.startsWith("set ")) {
				const assignment = parseCmdSetAssignment(line.slice(4));
				if (assignment) environment[assignment.key] = assignment.value;
				continue;
			}
			if (lower.startsWith("cd /d ")) {
				workingDirectory = line.slice(6).trim().replace(/^"|"$/g, "");
				continue;
			}
			commandLine = line;
			break;
		}
		if (!commandLine) return null;
		return {
			programArguments: parseCmdScriptCommandLine(commandLine),
			...workingDirectory ? { workingDirectory } : {},
			...Object.keys(environment).length > 0 ? { environment } : {},
			sourcePath: scriptPath
		};
	} catch {
		return null;
	}
}
function parseSchtasksQuery(output) {
	const entries = parseKeyValueOutput(output, ":");
	const info = {};
	const status = entries.status;
	if (status) info.status = status;
	const lastRunTime = entries["last run time"];
	if (lastRunTime) info.lastRunTime = lastRunTime;
	const lastRunResult = entries["last run result"];
	if (lastRunResult) info.lastRunResult = lastRunResult;
	return info;
}
function normalizeTaskResultCode(value) {
	if (!value) return null;
	const raw = value.trim().toLowerCase();
	if (!raw) return null;
	if (/^0x[0-9a-f]+$/.test(raw)) return `0x${raw.slice(2).replace(/^0+/, "") || "0"}`;
	if (/^\d+$/.test(raw)) {
		const numeric = Number.parseInt(raw, 10);
		if (Number.isFinite(numeric)) return `0x${numeric.toString(16)}`;
	}
	return null;
}
const RUNNING_RESULT_CODES = new Set(["0x41301"]);
const UNKNOWN_STATUS_DETAIL = "Task status is locale-dependent and no numeric Last Run Result was available.";
function deriveScheduledTaskRuntimeStatus(parsed) {
	const normalizedResult = normalizeTaskResultCode(parsed.lastRunResult);
	if (normalizedResult != null) {
		if (RUNNING_RESULT_CODES.has(normalizedResult)) return { status: "running" };
		return {
			status: "stopped",
			detail: `Task Last Run Result=${parsed.lastRunResult}; treating as not running.`
		};
	}
	if (parsed.status?.trim()) return {
		status: "unknown",
		detail: UNKNOWN_STATUS_DETAIL
	};
	return { status: "unknown" };
}
function buildTaskScript({ description, programArguments, workingDirectory, environment }) {
	const lines = ["@echo off"];
	const trimmedDescription = description?.trim();
	if (trimmedDescription) {
		assertNoCmdLineBreak(trimmedDescription, "Task description");
		lines.push(`rem ${trimmedDescription}`);
	}
	if (workingDirectory) lines.push(`cd /d ${quoteCmdScriptArg(workingDirectory)}`);
	if (environment) for (const [key, value] of Object.entries(environment)) {
		if (!value) continue;
		if (key.toUpperCase() === "PATH") continue;
		lines.push(renderCmdSetAssignment(key, value));
	}
	const command = programArguments.map(quoteCmdScriptArg).join(" ");
	lines.push(command);
	return `${lines.join("\r\n")}\r\n`;
}
function buildStartupLauncherScript(params) {
	const lines = ["@echo off"];
	const trimmedDescription = params.description?.trim();
	if (trimmedDescription) {
		assertNoCmdLineBreak(trimmedDescription, "Startup launcher description");
		lines.push(`rem ${trimmedDescription}`);
	}
	lines.push(`start "" /min cmd.exe /d /c ${quoteCmdScriptArg(params.scriptPath)}`);
	return `${lines.join("\r\n")}\r\n`;
}
async function assertSchtasksAvailable() {
	const res = await execSchtasks(["/Query"]);
	if (res.code === 0) return;
	const detail = res.stderr || res.stdout;
	throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
}
async function isStartupEntryInstalled(env) {
	try {
		await fs.access(resolveStartupEntryPath(env));
		return true;
	} catch {
		return false;
	}
}
async function isRegisteredScheduledTask(env) {
	return (await execSchtasks([
		"/Query",
		"/TN",
		resolveTaskName(env)
	]).catch(() => ({
		code: 1,
		stdout: "",
		stderr: ""
	}))).code === 0;
}
function launchFallbackTaskScript(scriptPath) {
	spawn("cmd.exe", [
		"/d",
		"/s",
		"/c",
		quoteCmdScriptArg(scriptPath)
	], {
		detached: true,
		stdio: "ignore",
		windowsHide: true
	}).unref();
}
function resolveConfiguredGatewayPort(env) {
	const raw = env.OPENCLAW_GATEWAY_PORT?.trim();
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
async function resolveFallbackRuntime(env) {
	const port = resolveConfiguredGatewayPort(env);
	if (!port) return {
		status: "unknown",
		detail: "Startup-folder login item installed; gateway port unknown."
	};
	const diagnostics = await inspectPortUsage(port).catch(() => null);
	if (!diagnostics) return {
		status: "unknown",
		detail: `Startup-folder login item installed; could not inspect port ${port}.`
	};
	const listener = diagnostics.listeners.find((item) => typeof item.pid === "number");
	return {
		status: diagnostics.status === "busy" ? "running" : "stopped",
		...listener?.pid ? { pid: listener.pid } : {},
		detail: diagnostics.status === "busy" ? `Startup-folder login item installed; listener detected on port ${port}.` : `Startup-folder login item installed; no listener detected on port ${port}.`
	};
}
async function stopStartupEntry(env, stdout) {
	const runtime = await resolveFallbackRuntime(env);
	if (typeof runtime.pid === "number" && runtime.pid > 0) killProcessTree(runtime.pid, { graceMs: 300 });
	stdout.write(`${formatLine("Stopped Windows login item", resolveTaskName(env))}\n`);
}
async function restartStartupEntry(env, stdout) {
	const runtime = await resolveFallbackRuntime(env);
	if (typeof runtime.pid === "number" && runtime.pid > 0) killProcessTree(runtime.pid, { graceMs: 300 });
	launchFallbackTaskScript(resolveTaskScriptPath(env));
	stdout.write(`${formatLine("Restarted Windows login item", resolveTaskName(env))}\n`);
	return { outcome: "completed" };
}
async function installScheduledTask({ env, stdout, programArguments, workingDirectory, environment, description }) {
	await assertSchtasksAvailable();
	const scriptPath = resolveTaskScriptPath(env);
	await fs.mkdir(path.dirname(scriptPath), { recursive: true });
	const taskDescription = resolveGatewayServiceDescription({
		env,
		environment,
		description
	});
	const script = buildTaskScript({
		description: taskDescription,
		programArguments,
		workingDirectory,
		environment
	});
	await fs.writeFile(scriptPath, script, "utf8");
	const taskName = resolveTaskName(env);
	const baseArgs = [
		"/Create",
		"/F",
		"/SC",
		"ONLOGON",
		"/RL",
		"LIMITED",
		"/TN",
		taskName,
		"/TR",
		quoteSchtasksArg(scriptPath)
	];
	const taskUser = resolveTaskUser(env);
	let create = await execSchtasks(taskUser ? [
		...baseArgs,
		"/RU",
		taskUser,
		"/NP",
		"/IT"
	] : baseArgs);
	if (create.code !== 0 && taskUser) create = await execSchtasks(baseArgs);
	if (create.code !== 0) {
		const detail = create.stderr || create.stdout;
		if (shouldFallbackToStartupEntry({
			code: create.code,
			detail
		})) {
			const startupEntryPath = resolveStartupEntryPath(env);
			await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
			const launcher = buildStartupLauncherScript({
				description: taskDescription,
				scriptPath
			});
			await fs.writeFile(startupEntryPath, launcher, "utf8");
			launchFallbackTaskScript(scriptPath);
			writeFormattedLines(stdout, [{
				label: "Installed Windows login item",
				value: startupEntryPath
			}, {
				label: "Task script",
				value: scriptPath
			}], { leadingBlankLine: true });
			return { scriptPath };
		}
		throw new Error(`schtasks create failed: ${detail}`.trim());
	}
	await execSchtasks([
		"/Run",
		"/TN",
		taskName
	]);
	writeFormattedLines(stdout, [{
		label: "Installed Scheduled Task",
		value: taskName
	}, {
		label: "Task script",
		value: scriptPath
	}], { leadingBlankLine: true });
	return { scriptPath };
}
async function uninstallScheduledTask({ env, stdout }) {
	await assertSchtasksAvailable();
	const taskName = resolveTaskName(env);
	if (await isRegisteredScheduledTask(env).catch(() => false)) await execSchtasks([
		"/Delete",
		"/F",
		"/TN",
		taskName
	]);
	const startupEntryPath = resolveStartupEntryPath(env);
	try {
		await fs.unlink(startupEntryPath);
		stdout.write(`${formatLine("Removed Windows login item", startupEntryPath)}\n`);
	} catch {}
	const scriptPath = resolveTaskScriptPath(env);
	try {
		await fs.unlink(scriptPath);
		stdout.write(`${formatLine("Removed task script", scriptPath)}\n`);
	} catch {
		stdout.write(`Task script not found at ${scriptPath}\n`);
	}
}
function isTaskNotRunning(res) {
	return (res.stderr || res.stdout).toLowerCase().includes("not running");
}
async function stopScheduledTask({ stdout, env }) {
	const effectiveEnv = env ?? process.env;
	try {
		await assertSchtasksAvailable();
	} catch (err) {
		if (await isStartupEntryInstalled(effectiveEnv)) {
			await stopStartupEntry(effectiveEnv, stdout);
			return;
		}
		throw err;
	}
	if (!await isRegisteredScheduledTask(effectiveEnv)) {
		if (await isStartupEntryInstalled(effectiveEnv)) {
			await stopStartupEntry(effectiveEnv, stdout);
			return;
		}
	}
	const taskName = resolveTaskName(effectiveEnv);
	const res = await execSchtasks([
		"/End",
		"/TN",
		taskName
	]);
	if (res.code !== 0 && !isTaskNotRunning(res)) throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
	stdout.write(`${formatLine("Stopped Scheduled Task", taskName)}\n`);
}
async function restartScheduledTask({ stdout, env }) {
	const effectiveEnv = env ?? process.env;
	try {
		await assertSchtasksAvailable();
	} catch (err) {
		if (await isStartupEntryInstalled(effectiveEnv)) return await restartStartupEntry(effectiveEnv, stdout);
		throw err;
	}
	if (!await isRegisteredScheduledTask(effectiveEnv)) {
		if (await isStartupEntryInstalled(effectiveEnv)) return await restartStartupEntry(effectiveEnv, stdout);
	}
	const taskName = resolveTaskName(effectiveEnv);
	await execSchtasks([
		"/End",
		"/TN",
		taskName
	]);
	const res = await execSchtasks([
		"/Run",
		"/TN",
		taskName
	]);
	if (res.code !== 0) throw new Error(`schtasks run failed: ${res.stderr || res.stdout}`.trim());
	stdout.write(`${formatLine("Restarted Scheduled Task", taskName)}\n`);
	return { outcome: "completed" };
}
async function isScheduledTaskInstalled(args) {
	const effectiveEnv = args.env ?? process.env;
	if (await isRegisteredScheduledTask(effectiveEnv)) return true;
	return await isStartupEntryInstalled(effectiveEnv);
}
async function readScheduledTaskRuntime(env = process.env) {
	try {
		await assertSchtasksAvailable();
	} catch (err) {
		if (await isStartupEntryInstalled(env)) return await resolveFallbackRuntime(env);
		return {
			status: "unknown",
			detail: String(err)
		};
	}
	const res = await execSchtasks([
		"/Query",
		"/TN",
		resolveTaskName(env),
		"/V",
		"/FO",
		"LIST"
	]);
	if (res.code !== 0) {
		if (await isStartupEntryInstalled(env)) return await resolveFallbackRuntime(env);
		const detail = (res.stderr || res.stdout).trim();
		const missing = detail.toLowerCase().includes("cannot find the file");
		return {
			status: missing ? "stopped" : "unknown",
			detail: detail || void 0,
			missingUnit: missing
		};
	}
	const parsed = parseSchtasksQuery(res.stdout || "");
	const derived = deriveScheduledTaskRuntimeStatus(parsed);
	return {
		status: derived.status,
		state: parsed.status,
		lastRunTime: parsed.lastRunTime,
		lastRunResult: parsed.lastRunResult,
		...derived.detail ? { detail: derived.detail } : {}
	};
}
//#endregion
//#region src/daemon/systemd-unit.ts
const SYSTEMD_LINE_BREAKS = /[\r\n]/;
function assertNoSystemdLineBreaks(value, label) {
	if (SYSTEMD_LINE_BREAKS.test(value)) throw new Error(`${label} cannot contain CR or LF characters.`);
}
function systemdEscapeArg(value) {
	assertNoSystemdLineBreaks(value, "Systemd unit values");
	if (!/[\s"\\]/.test(value)) return value;
	return `"${value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\"")}"`;
}
function renderEnvLines(env) {
	if (!env) return [];
	const entries = Object.entries(env).filter(([, value]) => typeof value === "string" && value.trim());
	if (entries.length === 0) return [];
	return entries.map(([key, value]) => {
		const rawValue = value ?? "";
		assertNoSystemdLineBreaks(key, "Systemd environment variable names");
		assertNoSystemdLineBreaks(rawValue, "Systemd environment variable values");
		return `Environment=${systemdEscapeArg(`${key}=${rawValue.trim()}`)}`;
	});
}
function buildSystemdUnit({ description, programArguments, workingDirectory, environment }) {
	const execStart = programArguments.map(systemdEscapeArg).join(" ");
	const descriptionValue = description?.trim() || "OpenClaw Gateway";
	assertNoSystemdLineBreaks(descriptionValue, "Systemd Description");
	const descriptionLine = `Description=${descriptionValue}`;
	const workingDirLine = workingDirectory ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}` : null;
	const envLines = renderEnvLines(environment);
	return [
		"[Unit]",
		descriptionLine,
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		`ExecStart=${execStart}`,
		"Restart=always",
		"RestartSec=5",
		"TimeoutStopSec=30",
		"TimeoutStartSec=30",
		"SuccessExitStatus=0 143",
		"KillMode=control-group",
		workingDirLine,
		...envLines,
		"",
		"[Install]",
		"WantedBy=default.target",
		""
	].filter((line) => line !== null).join("\n");
}
function parseSystemdExecStart(value) {
	return splitArgsPreservingQuotes(value, { escapeMode: "backslash" });
}
function parseSystemdEnvAssignment(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const unquoted = (() => {
		if (!(trimmed.startsWith("\"") && trimmed.endsWith("\""))) return trimmed;
		let out = "";
		let escapeNext = false;
		for (const ch of trimmed.slice(1, -1)) {
			if (escapeNext) {
				out += ch;
				escapeNext = false;
				continue;
			}
			if (ch === "\\\\") {
				escapeNext = true;
				continue;
			}
			out += ch;
		}
		return out;
	})();
	const eq = unquoted.indexOf("=");
	if (eq <= 0) return null;
	const key = unquoted.slice(0, eq).trim();
	if (!key) return null;
	return {
		key,
		value: unquoted.slice(eq + 1)
	};
}
//#endregion
//#region src/daemon/systemd.ts
function resolveSystemdUnitPathForName(env, name) {
	const home = toPosixPath(resolveHomeDir$1(env));
	return path.posix.join(home, ".config", "systemd", "user", `${name}.service`);
}
function resolveSystemdServiceName(env) {
	const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
	if (override) return override.endsWith(".service") ? override.slice(0, -8) : override;
	return resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
}
function resolveSystemdUnitPath(env) {
	return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}
function resolveSystemdUserUnitPath(env) {
	return resolveSystemdUnitPath(env);
}
async function readSystemdServiceExecStart(env) {
	const unitPath = resolveSystemdUnitPath(env);
	try {
		const content = await fs.readFile(unitPath, "utf8");
		let execStart = "";
		let workingDirectory = "";
		const inlineEnvironment = {};
		const environmentFileSpecs = [];
		for (const rawLine of content.split("\n")) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			if (line.startsWith("ExecStart=")) execStart = line.slice(10).trim();
			else if (line.startsWith("WorkingDirectory=")) workingDirectory = line.slice(17).trim();
			else if (line.startsWith("Environment=")) {
				const parsed = parseSystemdEnvAssignment(line.slice(12).trim());
				if (parsed) inlineEnvironment[parsed.key] = parsed.value;
			} else if (line.startsWith("EnvironmentFile=")) {
				const raw = line.slice(16).trim();
				if (raw) environmentFileSpecs.push(raw);
			}
		}
		if (!execStart) return null;
		const environmentFromFiles = await resolveSystemdEnvironmentFiles({
			environmentFileSpecs,
			env,
			unitPath
		});
		const mergedEnvironment = {
			...inlineEnvironment,
			...environmentFromFiles.environment
		};
		const mergedEnvironmentSources = {
			...buildEnvironmentValueSources(inlineEnvironment, "inline"),
			...buildEnvironmentValueSources(environmentFromFiles.environment, "file")
		};
		return {
			programArguments: parseSystemdExecStart(execStart),
			...workingDirectory ? { workingDirectory } : {},
			...Object.keys(mergedEnvironment).length > 0 ? { environment: mergedEnvironment } : {},
			...Object.keys(mergedEnvironmentSources).length > 0 ? { environmentValueSources: mergedEnvironmentSources } : {},
			sourcePath: unitPath
		};
	} catch {
		return null;
	}
}
function buildEnvironmentValueSources(environment, source) {
	return Object.fromEntries(Object.keys(environment).map((key) => [key, source]));
}
function expandSystemdSpecifier(input, env) {
	return input.replaceAll("%h", toPosixPath(resolveHomeDir$1(env)));
}
function parseEnvironmentFileSpecs(raw) {
	return splitArgsPreservingQuotes(raw, { escapeMode: "backslash" }).map((entry) => entry.trim()).filter(Boolean);
}
function parseEnvironmentFileLine(rawLine) {
	const trimmed = rawLine.trim();
	if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return null;
	const eq = trimmed.indexOf("=");
	if (eq <= 0) return null;
	const key = trimmed.slice(0, eq).trim();
	if (!key) return null;
	let value = trimmed.slice(eq + 1).trim();
	if (value.length >= 2 && (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
	return {
		key,
		value
	};
}
async function readSystemdEnvironmentFile(pathname) {
	const environment = {};
	const content = await fs.readFile(pathname, "utf8");
	for (const rawLine of content.split(/\r?\n/)) {
		const parsed = parseEnvironmentFileLine(rawLine);
		if (!parsed) continue;
		environment[parsed.key] = parsed.value;
	}
	return environment;
}
async function resolveSystemdEnvironmentFiles(params) {
	const resolved = {};
	if (params.environmentFileSpecs.length === 0) return { environment: resolved };
	const unitDir = path.posix.dirname(params.unitPath);
	for (const specRaw of params.environmentFileSpecs) for (const token of parseEnvironmentFileSpecs(specRaw)) {
		const pathnameRaw = token.startsWith("-") ? token.slice(1).trim() : token;
		if (!pathnameRaw) continue;
		const expanded = expandSystemdSpecifier(pathnameRaw, params.env);
		const pathname = path.posix.isAbsolute(expanded) ? expanded : path.posix.resolve(unitDir, expanded);
		try {
			const fromFile = await readSystemdEnvironmentFile(pathname);
			Object.assign(resolved, fromFile);
		} catch {
			continue;
		}
	}
	return { environment: resolved };
}
function parseSystemdShow(output) {
	const entries = parseKeyValueOutput(output, "=");
	const info = {};
	const activeState = entries.activestate;
	if (activeState) info.activeState = activeState;
	const subState = entries.substate;
	if (subState) info.subState = subState;
	const mainPidValue = entries.mainpid;
	if (mainPidValue) {
		const pid = parseStrictPositiveInteger(mainPidValue);
		if (pid !== void 0) info.mainPid = pid;
	}
	const execMainStatusValue = entries.execmainstatus;
	if (execMainStatusValue) {
		const status = parseStrictInteger(execMainStatusValue);
		if (status !== void 0) info.execMainStatus = status;
	}
	const execMainCode = entries.execmaincode;
	if (execMainCode) info.execMainCode = execMainCode;
	return info;
}
async function execSystemctl(args) {
	return await execFileUtf8("systemctl", args);
}
function readSystemctlDetail(result) {
	return `${result.stderr} ${result.stdout}`.trim();
}
function isSystemctlMissing(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return normalized.includes("not found") || normalized.includes("no such file or directory") || normalized.includes("spawn systemctl enoent") || normalized.includes("spawn systemctl eacces");
}
function isSystemdUnitNotEnabled(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return normalized.includes("disabled") || normalized.includes("static") || normalized.includes("indirect") || normalized.includes("masked") || normalized.includes("not-found") || normalized.includes("could not be found") || normalized.includes("failed to get unit file state");
}
function isSystemctlBusUnavailable(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return normalized.includes("failed to connect to bus") || normalized.includes("failed to connect to user scope bus") || normalized.includes("dbus_session_bus_address") || normalized.includes("xdg_runtime_dir") || normalized.includes("no medium found");
}
function isSystemdUserScopeUnavailable(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return isSystemctlMissing(normalized) || isSystemctlBusUnavailable(normalized) || normalized.includes("not been booted") || normalized.includes("not supported");
}
function isGenericSystemctlIsEnabledFailure(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase().trim();
	return normalized.startsWith("command failed: systemctl") && normalized.includes(" is-enabled ") && !normalized.includes("permission denied") && !normalized.includes("access denied") && !normalized.includes("no space left") && !normalized.includes("read-only file system") && !normalized.includes("out of memory") && !normalized.includes("cannot allocate memory");
}
function isNonFatalSystemdInstallProbeError(error) {
	const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return isSystemctlBusUnavailable(normalized) || isGenericSystemctlIsEnabledFailure(normalized);
}
function resolveSystemctlDirectUserScopeArgs() {
	return ["--user"];
}
function resolveSystemctlMachineScopeUser(env) {
	const sudoUser = env.SUDO_USER?.trim();
	if (sudoUser && sudoUser !== "root") return sudoUser;
	const fromEnv = env.USER?.trim() || env.LOGNAME?.trim();
	if (fromEnv) return fromEnv;
	try {
		return os.userInfo().username;
	} catch {
		return null;
	}
}
function resolveSystemctlMachineUserScopeArgs(user) {
	const trimmedUser = user.trim();
	if (!trimmedUser) return [];
	return [
		"--machine",
		`${trimmedUser}@`,
		"--user"
	];
}
function shouldFallbackToMachineUserScope(detail) {
	const normalized = detail.toLowerCase();
	return normalized.includes("failed to connect to bus") || normalized.includes("failed to connect to user scope bus") || normalized.includes("dbus_session_bus_address") || normalized.includes("xdg_runtime_dir");
}
async function execSystemctlUser(env, args) {
	const machineUser = resolveSystemctlMachineScopeUser(env);
	const sudoUser = env.SUDO_USER?.trim();
	if (sudoUser && sudoUser !== "root" && machineUser) {
		const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
		if (machineScopeArgs.length > 0) return await execSystemctl([...machineScopeArgs, ...args]);
	}
	const directResult = await execSystemctl([...resolveSystemctlDirectUserScopeArgs(), ...args]);
	if (directResult.code === 0) return directResult;
	const detail = `${directResult.stderr} ${directResult.stdout}`.trim();
	if (!machineUser || !shouldFallbackToMachineUserScope(detail)) return directResult;
	const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
	if (machineScopeArgs.length === 0) return directResult;
	return await execSystemctl([...machineScopeArgs, ...args]);
}
async function isSystemdUserServiceAvailable(env = process.env) {
	const res = await execSystemctlUser(env, ["status"]);
	if (res.code === 0) return true;
	const detail = `${res.stderr} ${res.stdout}`.trim();
	if (!detail) return false;
	return !isSystemdUserScopeUnavailable(detail);
}
async function assertSystemdAvailable(env = process.env) {
	const res = await execSystemctlUser(env, ["status"]);
	if (res.code === 0) return;
	const detail = readSystemctlDetail(res);
	if (isSystemctlMissing(detail)) throw new Error("systemctl not available; systemd user services are required on Linux.");
	if (!detail) throw new Error("systemctl --user unavailable: unknown error");
	if (!isSystemdUserScopeUnavailable(detail)) return;
	throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
}
async function installSystemdService({ env, stdout, programArguments, workingDirectory, environment, description }) {
	await assertSystemdAvailable(env);
	const unitPath = resolveSystemdUnitPath(env);
	await fs.mkdir(path.dirname(unitPath), { recursive: true });
	let backedUp = false;
	try {
		await fs.access(unitPath);
		const backupPath = `${unitPath}.bak`;
		await fs.copyFile(unitPath, backupPath);
		backedUp = true;
	} catch {}
	const unit = buildSystemdUnit({
		description: resolveGatewayServiceDescription({
			env,
			environment,
			description
		}),
		programArguments,
		workingDirectory,
		environment
	});
	await fs.writeFile(unitPath, unit, "utf8");
	const unitName = `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
	const reload = await execSystemctlUser(env, ["daemon-reload"]);
	if (reload.code !== 0) throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim());
	const enable = await execSystemctlUser(env, ["enable", unitName]);
	if (enable.code !== 0) throw new Error(`systemctl enable failed: ${enable.stderr || enable.stdout}`.trim());
	const restart = await execSystemctlUser(env, ["restart", unitName]);
	if (restart.code !== 0) throw new Error(`systemctl restart failed: ${restart.stderr || restart.stdout}`.trim());
	writeFormattedLines(stdout, [{
		label: "Installed systemd service",
		value: unitPath
	}, ...backedUp ? [{
		label: "Previous unit backed up to",
		value: `${unitPath}.bak`
	}] : []], { leadingBlankLine: true });
	return { unitPath };
}
async function uninstallSystemdService({ env, stdout }) {
	await assertSystemdAvailable(env);
	await execSystemctlUser(env, [
		"disable",
		"--now",
		`${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`
	]);
	const unitPath = resolveSystemdUnitPath(env);
	try {
		await fs.unlink(unitPath);
		stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
	} catch {
		stdout.write(`Systemd service not found at ${unitPath}\n`);
	}
}
async function runSystemdServiceAction(params) {
	const env = params.env ?? process.env;
	await assertSystemdAvailable(env);
	const unitName = `${resolveSystemdServiceName(env)}.service`;
	const res = await execSystemctlUser(env, [params.action, unitName]);
	if (res.code !== 0) throw new Error(`systemctl ${params.action} failed: ${res.stderr || res.stdout}`.trim());
	params.stdout.write(`${formatLine(params.label, unitName)}\n`);
}
async function stopSystemdService({ stdout, env }) {
	await runSystemdServiceAction({
		stdout,
		env,
		action: "stop",
		label: "Stopped systemd service"
	});
}
async function restartSystemdService({ stdout, env }) {
	await runSystemdServiceAction({
		stdout,
		env,
		action: "restart",
		label: "Restarted systemd service"
	});
	return { outcome: "completed" };
}
async function isSystemdServiceEnabled(args) {
	const env = args.env ?? process.env;
	try {
		await fs.access(resolveSystemdUnitPath(env));
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
	const res = await execSystemctlUser(env, ["is-enabled", `${resolveSystemdServiceName(env)}.service`]);
	if (res.code === 0) return true;
	const detail = readSystemctlDetail(res);
	if (isSystemctlMissing(detail) || isSystemdUnitNotEnabled(detail)) return false;
	throw new Error(`systemctl is-enabled unavailable: ${detail || "unknown error"}`.trim());
}
async function readSystemdServiceRuntime(env = process.env) {
	try {
		await assertSystemdAvailable(env);
	} catch (err) {
		return {
			status: "unknown",
			detail: err instanceof Error ? err.message : String(err)
		};
	}
	const res = await execSystemctlUser(env, [
		"show",
		`${resolveSystemdServiceName(env)}.service`,
		"--no-page",
		"--property",
		"ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode"
	]);
	if (res.code !== 0) {
		const detail = (res.stderr || res.stdout).trim();
		const missing = detail.toLowerCase().includes("not found");
		return {
			status: missing ? "stopped" : "unknown",
			detail: detail || void 0,
			missingUnit: missing
		};
	}
	const parsed = parseSystemdShow(res.stdout || "");
	const activeState = parsed.activeState?.toLowerCase();
	return {
		status: activeState === "active" ? "running" : activeState ? "stopped" : "unknown",
		state: parsed.activeState,
		subState: parsed.subState,
		pid: parsed.mainPid,
		lastExitStatus: parsed.execMainStatus,
		lastExitReason: parsed.execMainCode
	};
}
//#endregion
//#region src/daemon/service.ts
function ignoreInstallResult(install) {
	return async (args) => {
		await install(args);
	};
}
function describeGatewayServiceRestart(serviceNoun, result) {
	if (result.outcome === "scheduled") return {
		scheduled: true,
		daemonActionResult: "scheduled",
		message: `restart scheduled, ${serviceNoun.toLowerCase()} will restart momentarily`,
		progressMessage: `${serviceNoun} service restart scheduled.`
	};
	return {
		scheduled: false,
		daemonActionResult: "restarted",
		message: `${serviceNoun} service restarted.`,
		progressMessage: `${serviceNoun} service restarted.`
	};
}
const GATEWAY_SERVICE_REGISTRY = {
	darwin: {
		label: "LaunchAgent",
		loadedText: "loaded",
		notLoadedText: "not loaded",
		install: ignoreInstallResult(installLaunchAgent),
		uninstall: uninstallLaunchAgent,
		stop: stopLaunchAgent,
		restart: restartLaunchAgent,
		isLoaded: isLaunchAgentLoaded,
		readCommand: readLaunchAgentProgramArguments,
		readRuntime: readLaunchAgentRuntime
	},
	linux: {
		label: "systemd",
		loadedText: "enabled",
		notLoadedText: "disabled",
		install: ignoreInstallResult(installSystemdService),
		uninstall: uninstallSystemdService,
		stop: stopSystemdService,
		restart: restartSystemdService,
		isLoaded: isSystemdServiceEnabled,
		readCommand: readSystemdServiceExecStart,
		readRuntime: readSystemdServiceRuntime
	},
	win32: {
		label: "Scheduled Task",
		loadedText: "registered",
		notLoadedText: "missing",
		install: ignoreInstallResult(installScheduledTask),
		uninstall: uninstallScheduledTask,
		stop: stopScheduledTask,
		restart: restartScheduledTask,
		isLoaded: isScheduledTaskInstalled,
		readCommand: readScheduledTaskCommand,
		readRuntime: readScheduledTaskRuntime
	}
};
function isSupportedGatewayServicePlatform(platform) {
	return Object.hasOwn(GATEWAY_SERVICE_REGISTRY, platform);
}
function resolveGatewayService() {
	if (isSupportedGatewayServicePlatform(process.platform)) return GATEWAY_SERVICE_REGISTRY[process.platform];
	throw new Error(`Gateway service install not supported on ${process.platform}`);
}
//#endregion
//#region src/cli/daemon-cli/response.ts
function emitDaemonActionJson(payload) {
	defaultRuntime.log(JSON.stringify(payload, null, 2));
}
function buildDaemonServiceSnapshot(service, loaded) {
	return {
		label: service.label,
		loaded,
		loadedText: service.loadedText,
		notLoadedText: service.notLoadedText
	};
}
function createNullWriter() {
	return new Writable({ write(_chunk, _encoding, callback) {
		callback();
	} });
}
function createDaemonActionContext(params) {
	const warnings = [];
	const stdout = params.json ? createNullWriter() : process.stdout;
	const emit = (payload) => {
		if (!params.json) return;
		emitDaemonActionJson({
			action: params.action,
			...payload,
			warnings: payload.warnings ?? (warnings.length ? warnings : void 0)
		});
	};
	const fail = (message, hints) => {
		if (params.json) emit({
			ok: false,
			error: message,
			hints
		});
		else {
			defaultRuntime.error(message);
			if (hints?.length) for (const hint of hints) defaultRuntime.log(`Tip: ${hint}`);
		}
		defaultRuntime.exit(1);
	};
	return {
		stdout,
		warnings,
		emit,
		fail
	};
}
async function installDaemonServiceAndEmit(params) {
	try {
		await params.install();
	} catch (err) {
		params.fail(`${params.serviceNoun} install failed: ${String(err)}`);
		return;
	}
	let installed = true;
	try {
		installed = await params.service.isLoaded({ env: process.env });
	} catch {
		installed = true;
	}
	params.emit({
		ok: true,
		result: "installed",
		service: buildDaemonServiceSnapshot(params.service, installed),
		warnings: params.warnings.length ? params.warnings : void 0
	});
}
//#endregion
//#region src/infra/runtime-status.ts
function formatRuntimeStatusWithDetails({ status, pid, state, details = [] }) {
	const runtimeStatus = status ?? "unknown";
	const fullDetails = [];
	if (pid) fullDetails.push(`pid ${pid}`);
	if (state && state.toLowerCase() !== runtimeStatus) fullDetails.push(`state ${state}`);
	for (const detail of details) if (detail) fullDetails.push(detail);
	return fullDetails.length > 0 ? `${runtimeStatus} (${fullDetails.join(", ")})` : runtimeStatus;
}
//#endregion
//#region src/daemon/runtime-format.ts
function formatRuntimeStatus(runtime) {
	if (!runtime) return null;
	const details = [];
	if (runtime.subState) details.push(`sub ${runtime.subState}`);
	if (runtime.lastExitStatus !== void 0) details.push(`last exit ${runtime.lastExitStatus}`);
	if (runtime.lastExitReason) details.push(`reason ${runtime.lastExitReason}`);
	if (runtime.lastRunResult) details.push(`last run ${runtime.lastRunResult}`);
	if (runtime.lastRunTime) details.push(`last run time ${runtime.lastRunTime}`);
	if (runtime.detail) details.push(runtime.detail);
	return formatRuntimeStatusWithDetails({
		status: runtime.status,
		pid: runtime.pid,
		state: runtime.state,
		details
	});
}
//#endregion
//#region src/daemon/runtime-hints.ts
function toDarwinDisplayPath(value) {
	return toPosixPath(value).replace(/^[A-Za-z]:/, "");
}
function buildPlatformRuntimeLogHints(params) {
	const platform = params.platform ?? process.platform;
	const env = params.env ?? process.env;
	if (platform === "darwin") {
		const logs = resolveGatewayLogPaths(env);
		return [`Launchd stdout (if installed): ${toDarwinDisplayPath(logs.stdoutPath)}`, `Launchd stderr (if installed): ${toDarwinDisplayPath(logs.stderrPath)}`];
	}
	if (platform === "linux") return [`Logs: journalctl --user -u ${params.systemdServiceName}.service -n 200 --no-pager`];
	if (platform === "win32") return [`Logs: schtasks /Query /TN "${params.windowsTaskName}" /V /FO LIST`];
	return [];
}
function buildPlatformServiceStartHints(params) {
	const platform = params.platform ?? process.platform;
	const base = [params.installCommand, params.startCommand];
	switch (platform) {
		case "darwin": return [...base, `launchctl bootstrap gui/$UID ${params.launchAgentPlistPath}`];
		case "linux": return [...base, `systemctl --user start ${params.systemdServiceName}.service`];
		case "win32": return [...base, `schtasks /Run /TN "${params.windowsTaskName}"`];
		default: return base;
	}
}
//#endregion
//#region src/cli/shared/parse-port.ts
function parsePort(raw) {
	if (raw === void 0 || raw === null) return null;
	return parseStrictPositiveInteger(raw) ?? null;
}
//#endregion
//#region src/cli/daemon-cli/shared.ts
function createCliStatusTextStyles() {
	const rich = isRich();
	return {
		rich,
		label: (value) => colorize(rich, theme.muted, value),
		accent: (value) => colorize(rich, theme.accent, value),
		infoText: (value) => colorize(rich, theme.info, value),
		okText: (value) => colorize(rich, theme.success, value),
		warnText: (value) => colorize(rich, theme.warn, value),
		errorText: (value) => colorize(rich, theme.error, value)
	};
}
function resolveRuntimeStatusColor(status) {
	const runtimeStatus = status ?? "unknown";
	return runtimeStatus === "running" ? theme.success : runtimeStatus === "stopped" ? theme.error : runtimeStatus === "unknown" ? theme.muted : theme.warn;
}
function parsePortFromArgs(programArguments) {
	if (!programArguments?.length) return null;
	for (let i = 0; i < programArguments.length; i += 1) {
		const arg = programArguments[i];
		if (arg === "--port") {
			const next = programArguments[i + 1];
			const parsed = parsePort(next);
			if (parsed) return parsed;
		}
		if (arg?.startsWith("--port=")) {
			const parsed = parsePort(arg.split("=", 2)[1]);
			if (parsed) return parsed;
		}
	}
	return null;
}
function pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost) {
	if (bindMode === "custom" && customBindHost?.trim()) return customBindHost.trim();
	if (bindMode === "tailnet") return tailnetIPv4 ?? "127.0.0.1";
	if (bindMode === "lan") return "127.0.0.1";
	return "127.0.0.1";
}
const SAFE_DAEMON_ENV_KEYS = [
	"OPENCLAW_PROFILE",
	"OPENCLAW_STATE_DIR",
	"OPENCLAW_CONFIG_PATH",
	"OPENCLAW_GATEWAY_PORT",
	"OPENCLAW_NIX_MODE"
];
function filterDaemonEnv(env) {
	if (!env) return {};
	const filtered = {};
	for (const key of SAFE_DAEMON_ENV_KEYS) {
		const value = env[key];
		if (!value?.trim()) continue;
		filtered[key] = value.trim();
	}
	return filtered;
}
function safeDaemonEnv(env) {
	const filtered = filterDaemonEnv(env);
	return Object.entries(filtered).map(([key, value]) => `${key}=${value}`);
}
function normalizeListenerAddress(raw) {
	let value = raw.trim();
	if (!value) return value;
	value = value.replace(/^TCP\s+/i, "");
	value = value.replace(/\s+\(LISTEN\)\s*$/i, "");
	return value.trim();
}
function renderRuntimeHints(runtime, env = process.env) {
	if (!runtime) return [];
	const hints = [];
	const fileLog = (() => {
		try {
			return getResolvedLoggerSettings().file;
		} catch {
			return null;
		}
	})();
	if (runtime.missingUnit) {
		hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		return hints;
	}
	if (runtime.status === "stopped") {
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		hints.push(...buildPlatformRuntimeLogHints({
			env,
			systemdServiceName: resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE),
			windowsTaskName: resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE)
		}));
	}
	return hints;
}
function renderGatewayServiceStartHints(env = process.env) {
	const profile = env.OPENCLAW_PROFILE;
	return buildPlatformServiceStartHints({
		installCommand: formatCliCommand("openclaw gateway install", env),
		startCommand: formatCliCommand("openclaw gateway", env),
		launchAgentPlistPath: `~/Library/LaunchAgents/${resolveGatewayLaunchAgentLabel(profile)}.plist`,
		systemdServiceName: resolveGatewaySystemdServiceName(profile),
		windowsTaskName: resolveGatewayWindowsTaskName(profile)
	});
}
//#endregion
//#region src/cli/daemon-cli/install.ts
async function runDaemonInstall(opts) {
	const json = Boolean(opts.json);
	const { stdout, warnings, emit, fail } = createDaemonActionContext({
		action: "install",
		json
	});
	if (resolveIsNixMode(process.env)) {
		fail("Nix mode detected; service install is disabled.");
		return;
	}
	const cfg = await readBestEffortConfig();
	const portOverride = parsePort(opts.port);
	if (opts.port !== void 0 && portOverride === null) {
		fail("Invalid port");
		return;
	}
	const port = portOverride ?? resolveGatewayPort(cfg);
	if (!Number.isFinite(port) || port <= 0) {
		fail("Invalid port");
		return;
	}
	const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_GATEWAY_DAEMON_RUNTIME;
	if (!isGatewayDaemonRuntime(runtimeRaw)) {
		fail("Invalid --runtime (use \"node\" or \"bun\")");
		return;
	}
	const service = resolveGatewayService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch (err) {
		if (isNonFatalSystemdInstallProbeError(err)) loaded = false;
		else {
			fail(`Gateway service check failed: ${String(err)}`);
			return;
		}
	}
	if (loaded) {
		if (!opts.force) {
			emit({
				ok: true,
				result: "already-installed",
				message: `Gateway service already ${service.loadedText}.`,
				service: buildDaemonServiceSnapshot(service, loaded)
			});
			if (!json) {
				defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
				defaultRuntime.log(`Reinstall with: ${formatCliCommand("openclaw gateway install --force")}`);
			}
			return;
		}
	}
	const tokenResolution = await resolveGatewayInstallToken({
		config: cfg,
		env: process.env,
		explicitToken: opts.token,
		autoGenerateWhenMissing: true,
		persistGeneratedToken: true
	});
	if (tokenResolution.unavailableReason) {
		fail(`Gateway install blocked: ${tokenResolution.unavailableReason}`);
		return;
	}
	for (const warning of tokenResolution.warnings) if (json) warnings.push(warning);
	else defaultRuntime.log(warning);
	const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
		env: process.env,
		port,
		runtime: runtimeRaw,
		warn: (message) => {
			if (json) warnings.push(message);
			else defaultRuntime.log(message);
		},
		config: cfg
	});
	await installDaemonServiceAndEmit({
		serviceNoun: "Gateway",
		service,
		warnings,
		emit,
		fail,
		install: async () => {
			await service.install({
				env: process.env,
				stdout,
				programArguments,
				workingDirectory,
				environment
			});
		}
	});
}
//#endregion
//#region src/gateway/probe.ts
async function probeGateway(opts) {
	const startedAt = Date.now();
	const instanceId = randomUUID();
	let connectLatencyMs = null;
	let connectError = null;
	let close = null;
	return await new Promise((resolve) => {
		let settled = false;
		const settle = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.stop();
			resolve({
				url: opts.url,
				...result
			});
		};
		const client = new GatewayClient({
			url: opts.url,
			token: opts.auth?.token,
			password: opts.auth?.password,
			scopes: [READ_SCOPE],
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			clientVersion: "dev",
			mode: GATEWAY_CLIENT_MODES.PROBE,
			instanceId,
			onConnectError: (err) => {
				connectError = formatErrorMessage(err);
			},
			onClose: (code, reason) => {
				close = {
					code,
					reason
				};
			},
			onHelloOk: async () => {
				connectLatencyMs = Date.now() - startedAt;
				try {
					const [health, status, presence, configSnapshot] = await Promise.all([
						client.request("health"),
						client.request("status"),
						client.request("system-presence"),
						client.request("config.get", {})
					]);
					settle({
						ok: true,
						connectLatencyMs,
						error: null,
						close,
						health,
						status,
						presence: Array.isArray(presence) ? presence : null,
						configSnapshot
					});
				} catch (err) {
					settle({
						ok: false,
						connectLatencyMs,
						error: formatErrorMessage(err),
						close,
						health: null,
						status: null,
						presence: null,
						configSnapshot: null
					});
				}
			}
		});
		const timer = setTimeout(() => {
			settle({
				ok: false,
				connectLatencyMs,
				error: connectError ? `connect failed: ${connectError}` : "timeout",
				close,
				health: null,
				status: null,
				presence: null,
				configSnapshot: null
			});
		}, Math.max(250, opts.timeoutMs));
		client.start();
	});
}
//#endregion
//#region src/infra/gateway-process-argv.ts
function normalizeProcArg(arg) {
	return arg.replaceAll("\\", "/").toLowerCase();
}
function parseProcCmdline(raw) {
	return raw.split("\0").map((entry) => entry.trim()).filter(Boolean);
}
function isGatewayArgv(args, opts) {
	const normalized = args.map(normalizeProcArg);
	if (!normalized.includes("gateway")) return false;
	const entryCandidates = [
		"dist/index.js",
		"dist/entry.js",
		"openclaw.mjs",
		"scripts/run-node.mjs",
		"src/index.ts"
	];
	if (normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry)))) return true;
	const exe = (normalized[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
	return exe.endsWith("/openclaw") || exe === "openclaw" || opts?.allowGatewayBinary === true && exe.endsWith("/openclaw-gateway");
}
//#endregion
//#region src/config/issue-format.ts
function normalizeConfigIssuePath(path) {
	if (typeof path !== "string") return "<root>";
	const trimmed = path.trim();
	return trimmed ? trimmed : "<root>";
}
function resolveIssuePathForLine(path, opts) {
	if (opts?.normalizeRoot) return normalizeConfigIssuePath(path);
	return typeof path === "string" ? path : "";
}
function formatConfigIssueLine(issue, marker = "-", opts) {
	return `${marker ? `${marker} ` : ""}${sanitizeTerminalText(resolveIssuePathForLine(issue.path, opts))}: ${sanitizeTerminalText(issue.message)}`;
}
function formatConfigIssueLines(issues, marker = "-", opts) {
	return issues.map((issue) => formatConfigIssueLine(issue, marker, opts));
}
//#endregion
//#region src/daemon/service-audit.ts
const SERVICE_AUDIT_CODES = {
	gatewayCommandMissing: "gateway-command-missing",
	gatewayEntrypointMismatch: "gateway-entrypoint-mismatch",
	gatewayPathMissing: "gateway-path-missing",
	gatewayPathMissingDirs: "gateway-path-missing-dirs",
	gatewayPathNonMinimal: "gateway-path-nonminimal",
	gatewayTokenEmbedded: "gateway-token-embedded",
	gatewayTokenMismatch: "gateway-token-mismatch",
	gatewayRuntimeBun: "gateway-runtime-bun",
	gatewayRuntimeNodeVersionManager: "gateway-runtime-node-version-manager",
	gatewayRuntimeNodeSystemMissing: "gateway-runtime-node-system-missing",
	gatewayTokenDrift: "gateway-token-drift",
	launchdKeepAlive: "launchd-keep-alive",
	launchdRunAtLoad: "launchd-run-at-load",
	systemdAfterNetworkOnline: "systemd-after-network-online",
	systemdRestartSec: "systemd-restart-sec",
	systemdWantsNetworkOnline: "systemd-wants-network-online"
};
function hasGatewaySubcommand(programArguments) {
	return Boolean(programArguments?.some((arg) => arg === "gateway"));
}
function parseSystemdUnit(content) {
	const after = /* @__PURE__ */ new Set();
	const wants = /* @__PURE__ */ new Set();
	let restartSec;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) continue;
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (!value) continue;
		if (key === "After") {
			for (const entry of value.split(/\s+/)) if (entry) after.add(entry);
		} else if (key === "Wants") {
			for (const entry of value.split(/\s+/)) if (entry) wants.add(entry);
		} else if (key === "RestartSec") restartSec = value;
	}
	return {
		after,
		wants,
		restartSec
	};
}
function isRestartSecPreferred(value) {
	if (!value) return false;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) return false;
	return Math.abs(parsed - 5) < .01;
}
async function auditSystemdUnit(env, issues) {
	const unitPath = resolveSystemdUserUnitPath(env);
	let content = "";
	try {
		content = await fs.readFile(unitPath, "utf8");
	} catch {
		return;
	}
	const parsed = parseSystemdUnit(content);
	if (!parsed.after.has("network-online.target")) issues.push({
		code: SERVICE_AUDIT_CODES.systemdAfterNetworkOnline,
		message: "Missing systemd After=network-online.target",
		detail: unitPath,
		level: "recommended"
	});
	if (!parsed.wants.has("network-online.target")) issues.push({
		code: SERVICE_AUDIT_CODES.systemdWantsNetworkOnline,
		message: "Missing systemd Wants=network-online.target",
		detail: unitPath,
		level: "recommended"
	});
	if (!isRestartSecPreferred(parsed.restartSec)) issues.push({
		code: SERVICE_AUDIT_CODES.systemdRestartSec,
		message: "RestartSec does not match the recommended 5s",
		detail: unitPath,
		level: "recommended"
	});
}
async function auditLaunchdPlist(env, issues) {
	const plistPath = resolveLaunchAgentPlistPath(env);
	let content = "";
	try {
		content = await fs.readFile(plistPath, "utf8");
	} catch {
		return;
	}
	const hasRunAtLoad = /<key>RunAtLoad<\/key>\s*<true\s*\/>/i.test(content);
	const hasKeepAlive = /<key>KeepAlive<\/key>\s*<true\s*\/>/i.test(content);
	if (!hasRunAtLoad) issues.push({
		code: SERVICE_AUDIT_CODES.launchdRunAtLoad,
		message: "LaunchAgent is missing RunAtLoad=true",
		detail: plistPath,
		level: "recommended"
	});
	if (!hasKeepAlive) issues.push({
		code: SERVICE_AUDIT_CODES.launchdKeepAlive,
		message: "LaunchAgent is missing KeepAlive=true",
		detail: plistPath,
		level: "recommended"
	});
}
function auditGatewayCommand(programArguments, issues) {
	if (!programArguments || programArguments.length === 0) return;
	if (!hasGatewaySubcommand(programArguments)) issues.push({
		code: SERVICE_AUDIT_CODES.gatewayCommandMissing,
		message: "Service command does not include the gateway subcommand",
		level: "aggressive"
	});
}
function auditGatewayToken(command, issues, expectedGatewayToken) {
	const serviceToken = readEmbeddedGatewayToken(command);
	if (!serviceToken) return;
	issues.push({
		code: SERVICE_AUDIT_CODES.gatewayTokenEmbedded,
		message: "Gateway service embeds OPENCLAW_GATEWAY_TOKEN and should be reinstalled.",
		detail: "Run `openclaw gateway install --force` to remove embedded service token.",
		level: "recommended"
	});
	const expectedToken = expectedGatewayToken?.trim();
	if (!expectedToken || serviceToken === expectedToken) return;
	issues.push({
		code: SERVICE_AUDIT_CODES.gatewayTokenMismatch,
		message: "Gateway service OPENCLAW_GATEWAY_TOKEN does not match gateway.auth.token in openclaw.json",
		detail: "service token is stale",
		level: "recommended"
	});
}
function readEmbeddedGatewayToken(command) {
	if (!command) return;
	if (command.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN === "file") return;
	return command.environment?.OPENCLAW_GATEWAY_TOKEN?.trim() || void 0;
}
function getPathModule(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}
function normalizePathEntry(entry, platform) {
	const normalized = getPathModule(platform).normalize(entry).replaceAll("\\", "/");
	if (platform === "win32") return normalized.toLowerCase();
	return normalized;
}
function auditGatewayServicePath(command, issues, env, platform) {
	if (platform === "win32") return;
	const servicePath = command?.environment?.PATH;
	if (!servicePath) {
		issues.push({
			code: SERVICE_AUDIT_CODES.gatewayPathMissing,
			message: "Gateway service PATH is not set; the daemon should use a minimal PATH.",
			level: "recommended"
		});
		return;
	}
	const expected = getMinimalServicePathPartsFromEnv({
		platform,
		env
	});
	const parts = servicePath.split(getPathModule(platform).delimiter).map((entry) => entry.trim()).filter(Boolean);
	const normalizedParts = new Set(parts.map((entry) => normalizePathEntry(entry, platform)));
	const normalizedExpected = new Set(expected.map((entry) => normalizePathEntry(entry, platform)));
	const missing = expected.filter((entry) => {
		const normalized = normalizePathEntry(entry, platform);
		return !normalizedParts.has(normalized);
	});
	if (missing.length > 0) issues.push({
		code: SERVICE_AUDIT_CODES.gatewayPathMissingDirs,
		message: `Gateway service PATH missing required dirs: ${missing.join(", ")}`,
		level: "recommended"
	});
	const nonMinimal = parts.filter((entry) => {
		const normalized = normalizePathEntry(entry, platform);
		if (normalizedExpected.has(normalized)) return false;
		return normalized.includes("/.nvm/") || normalized.includes("/.fnm/") || normalized.includes("/.volta/") || normalized.includes("/.asdf/") || normalized.includes("/.n/") || normalized.includes("/.nodenv/") || normalized.includes("/.nodebrew/") || normalized.includes("/nvs/") || normalized.includes("/.local/share/pnpm/") || normalized.includes("/pnpm/") || normalized.endsWith("/pnpm");
	});
	if (nonMinimal.length > 0) issues.push({
		code: SERVICE_AUDIT_CODES.gatewayPathNonMinimal,
		message: "Gateway service PATH includes version managers or package managers; recommend a minimal PATH.",
		detail: nonMinimal.join(", "),
		level: "recommended"
	});
}
async function auditGatewayRuntime(env, command, issues, platform) {
	const execPath = command?.programArguments?.[0];
	if (!execPath) return;
	if (isBunRuntime(execPath)) {
		issues.push({
			code: SERVICE_AUDIT_CODES.gatewayRuntimeBun,
			message: "Gateway service uses Bun; Bun is incompatible with WhatsApp + Telegram channels.",
			detail: execPath,
			level: "recommended"
		});
		return;
	}
	if (!isNodeRuntime(execPath)) return;
	if (isVersionManagedNodePath(execPath, platform)) {
		issues.push({
			code: SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
			message: "Gateway service uses Node from a version manager; it can break after upgrades.",
			detail: execPath,
			level: "recommended"
		});
		if (!isSystemNodePath(execPath, env, platform)) {
			if (!await resolveSystemNodePath(env, platform)) issues.push({
				code: SERVICE_AUDIT_CODES.gatewayRuntimeNodeSystemMissing,
				message: "System Node 22 LTS (22.16+) or Node 24 not found; install it before migrating away from version managers.",
				level: "recommended"
			});
		}
	}
}
/**
* Check if the service's embedded token differs from the config file token.
* Returns an issue if drift is detected (service will use old token after restart).
*/
function checkTokenDrift(params) {
	const serviceToken = params.serviceToken?.trim() || void 0;
	const configToken = params.configToken?.trim() || void 0;
	if (!serviceToken) return null;
	if (configToken && serviceToken !== configToken) return {
		code: SERVICE_AUDIT_CODES.gatewayTokenDrift,
		message: "Config token differs from service token. The daemon will use the old token after restart.",
		detail: "Run `openclaw gateway install --force` to sync the token.",
		level: "recommended"
	};
	return null;
}
async function auditGatewayServiceConfig(params) {
	const issues = [];
	const platform = params.platform ?? process.platform;
	auditGatewayCommand(params.command?.programArguments, issues);
	auditGatewayToken(params.command, issues, params.expectedGatewayToken);
	auditGatewayServicePath(params.command, issues, params.env, platform);
	await auditGatewayRuntime(params.env, params.command, issues, platform);
	if (platform === "linux") await auditSystemdUnit(params.env, issues);
	else if (platform === "darwin") await auditLaunchdPlist(params.env, issues);
	return {
		ok: issues.length === 0,
		issues
	};
}
//#endregion
//#region src/daemon/systemd-hints.ts
function isSystemdUnavailableDetail(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return normalized.includes("systemctl --user unavailable") || normalized.includes("systemctl not available") || normalized.includes("not been booted with systemd") || normalized.includes("failed to connect to bus") || normalized.includes("systemd user services are required");
}
function renderSystemdUnavailableHints(options = {}) {
	if (options.wsl) return [
		"WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
		"Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
		"Verify: systemctl --user status"
	];
	return ["systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.", `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`];
}
//#endregion
//#region src/cli/daemon-cli/gateway-token-drift.ts
function resolveGatewayTokenForDriftCheck(params) {
	params.env;
	return resolveGatewayDriftCheckCredentialsFromConfig({ cfg: params.cfg }).token;
}
//#endregion
//#region src/cli/daemon-cli/lifecycle-core.ts
async function maybeAugmentSystemdHints(hints) {
	if (process.platform !== "linux") return hints;
	if (await isSystemdUserServiceAvailable().catch(() => false)) return hints;
	return [...hints, ...renderSystemdUnavailableHints({ wsl: await isWSL() })];
}
function createActionIO(params) {
	const stdout = params.json ? createNullWriter() : process.stdout;
	const emit = (payload) => {
		if (!params.json) return;
		emitDaemonActionJson({
			action: params.action,
			...payload
		});
	};
	const fail = (message, hints) => {
		if (params.json) emit({
			ok: false,
			error: message,
			hints
		});
		else defaultRuntime.error(message);
		defaultRuntime.exit(1);
	};
	return {
		stdout,
		emit,
		fail
	};
}
async function handleServiceNotLoaded(params) {
	const hints = await maybeAugmentSystemdHints(params.renderStartHints());
	params.emit({
		ok: true,
		result: "not-loaded",
		message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
		hints,
		service: buildDaemonServiceSnapshot(params.service, params.loaded)
	});
	if (!params.json) {
		defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
		for (const hint of hints) defaultRuntime.log(`Start with: ${hint}`);
	}
}
async function resolveServiceLoadedOrFail(params) {
	try {
		return await params.service.isLoaded({ env: process.env });
	} catch (err) {
		params.fail(`${params.serviceNoun} service check failed: ${String(err)}`);
		return null;
	}
}
/**
* Best-effort config validation. Returns a string describing the issues if
* config exists and is invalid, or null if config is valid/missing/unreadable.
*
* Note: This reads the config file snapshot in the current CLI environment.
* Configs using env vars only available in the service context (launchd/systemd)
* may produce false positives, but the check is intentionally best-effort —
* a false positive here is safer than a crash on startup. (#35862)
*/
async function getConfigValidationError() {
	try {
		const snapshot = await readConfigFileSnapshot();
		if (!snapshot.exists || snapshot.valid) return null;
		return snapshot.issues.length > 0 ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n") : "Unknown validation issue.";
	} catch {
		return null;
	}
}
async function runServiceUninstall(params) {
	const { stdout, emit, fail } = createActionIO({
		action: "uninstall",
		json: Boolean(params.opts?.json)
	});
	if (resolveIsNixMode(process.env)) {
		fail("Nix mode detected; service uninstall is disabled.");
		return;
	}
	let loaded = false;
	try {
		loaded = await params.service.isLoaded({ env: process.env });
	} catch {
		loaded = false;
	}
	if (loaded && params.stopBeforeUninstall) try {
		await params.service.stop({
			env: process.env,
			stdout
		});
	} catch {}
	try {
		await params.service.uninstall({
			env: process.env,
			stdout
		});
	} catch (err) {
		fail(`${params.serviceNoun} uninstall failed: ${String(err)}`);
		return;
	}
	loaded = false;
	try {
		loaded = await params.service.isLoaded({ env: process.env });
	} catch {
		loaded = false;
	}
	if (loaded && params.assertNotLoadedAfterUninstall) {
		fail(`${params.serviceNoun} service still loaded after uninstall.`);
		return;
	}
	emit({
		ok: true,
		result: "uninstalled",
		service: buildDaemonServiceSnapshot(params.service, loaded)
	});
}
async function runServiceStart(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createActionIO({
		action: "start",
		json
	});
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return;
	if (!loaded) {
		await handleServiceNotLoaded({
			serviceNoun: params.serviceNoun,
			service: params.service,
			loaded,
			renderStartHints: params.renderStartHints,
			json,
			emit
		});
		return;
	}
	{
		const configError = await getConfigValidationError();
		if (configError) {
			fail(`${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`);
			return;
		}
	}
	try {
		const restartResult = await params.service.restart({
			env: process.env,
			stdout
		});
		const restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
		if (restartStatus.scheduled) {
			emit({
				ok: true,
				result: restartStatus.daemonActionResult,
				message: restartStatus.message,
				service: buildDaemonServiceSnapshot(params.service, loaded)
			});
			if (!json) defaultRuntime.log(restartStatus.message);
			return;
		}
	} catch (err) {
		const hints = params.renderStartHints();
		fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
		return;
	}
	let started = true;
	try {
		started = await params.service.isLoaded({ env: process.env });
	} catch {
		started = true;
	}
	emit({
		ok: true,
		result: "started",
		service: buildDaemonServiceSnapshot(params.service, started)
	});
}
async function runServiceStop(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createActionIO({
		action: "stop",
		json
	});
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return;
	if (!loaded) {
		try {
			const handled = await params.onNotLoaded?.({
				json,
				stdout,
				fail
			});
			if (handled) {
				emit({
					ok: true,
					result: handled.result,
					message: handled.message,
					warnings: handled.warnings,
					service: buildDaemonServiceSnapshot(params.service, false)
				});
				if (!json && handled.message) defaultRuntime.log(handled.message);
				return;
			}
		} catch (err) {
			fail(`${params.serviceNoun} stop failed: ${String(err)}`);
			return;
		}
		emit({
			ok: true,
			result: "not-loaded",
			message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
			service: buildDaemonServiceSnapshot(params.service, loaded)
		});
		if (!json) defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
		return;
	}
	try {
		await params.service.stop({
			env: process.env,
			stdout
		});
	} catch (err) {
		fail(`${params.serviceNoun} stop failed: ${String(err)}`);
		return;
	}
	let stopped = false;
	try {
		stopped = await params.service.isLoaded({ env: process.env });
	} catch {
		stopped = false;
	}
	emit({
		ok: true,
		result: "stopped",
		service: buildDaemonServiceSnapshot(params.service, stopped)
	});
}
async function runServiceRestart(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createActionIO({
		action: "restart",
		json
	});
	const warnings = [];
	let handledNotLoaded = null;
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return false;
	{
		const configError = await getConfigValidationError();
		if (configError) {
			fail(`${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`);
			return false;
		}
	}
	if (!loaded) {
		try {
			handledNotLoaded = await params.onNotLoaded?.({
				json,
				stdout,
				fail
			}) ?? null;
		} catch (err) {
			fail(`${params.serviceNoun} restart failed: ${String(err)}`);
			return false;
		}
		if (!handledNotLoaded) {
			await handleServiceNotLoaded({
				serviceNoun: params.serviceNoun,
				service: params.service,
				loaded,
				renderStartHints: params.renderStartHints,
				json,
				emit
			});
			return false;
		}
		if (handledNotLoaded.warnings?.length) warnings.push(...handledNotLoaded.warnings);
	}
	if (loaded && params.checkTokenDrift) try {
		const serviceToken = (await params.service.readCommand(process.env))?.environment?.OPENCLAW_GATEWAY_TOKEN;
		const driftIssue = checkTokenDrift({
			serviceToken,
			configToken: resolveGatewayTokenForDriftCheck({
				cfg: await readBestEffortConfig(),
				env: process.env
			})
		});
		if (driftIssue) {
			const warning = driftIssue.detail ? `${driftIssue.message} ${driftIssue.detail}` : driftIssue.message;
			warnings.push(warning);
			if (!json) {
				defaultRuntime.log(`\n⚠️  ${driftIssue.message}`);
				if (driftIssue.detail) defaultRuntime.log(`   ${driftIssue.detail}\n`);
			}
		}
	} catch (err) {
		if (isGatewaySecretRefUnavailableError(err, "gateway.auth.token")) {
			const warning = "Unable to verify gateway token drift: gateway.auth.token SecretRef is configured but unavailable in this command path.";
			warnings.push(warning);
			if (!json) defaultRuntime.log(`\n⚠️  ${warning}\n`);
		}
	}
	try {
		let restartResult = { outcome: "completed" };
		if (loaded) restartResult = await params.service.restart({
			env: process.env,
			stdout
		});
		let restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
		if (restartStatus.scheduled) {
			emit({
				ok: true,
				result: restartStatus.daemonActionResult,
				message: restartStatus.message,
				service: buildDaemonServiceSnapshot(params.service, loaded),
				warnings: warnings.length ? warnings : void 0
			});
			if (!json) defaultRuntime.log(restartStatus.message);
			return true;
		}
		if (params.postRestartCheck) {
			const postRestartResult = await params.postRestartCheck({
				json,
				stdout,
				warnings,
				fail
			});
			if (postRestartResult) {
				restartStatus = describeGatewayServiceRestart(params.serviceNoun, postRestartResult);
				if (restartStatus.scheduled) {
					emit({
						ok: true,
						result: restartStatus.daemonActionResult,
						message: restartStatus.message,
						service: buildDaemonServiceSnapshot(params.service, loaded),
						warnings: warnings.length ? warnings : void 0
					});
					if (!json) defaultRuntime.log(restartStatus.message);
					return true;
				}
			}
		}
		let restarted = loaded;
		if (loaded) try {
			restarted = await params.service.isLoaded({ env: process.env });
		} catch {
			restarted = true;
		}
		emit({
			ok: true,
			result: "restarted",
			message: handledNotLoaded?.message,
			service: buildDaemonServiceSnapshot(params.service, restarted),
			warnings: warnings.length ? warnings : void 0
		});
		if (!json && handledNotLoaded?.message) defaultRuntime.log(handledNotLoaded.message);
		return true;
	} catch (err) {
		const hints = params.renderStartHints();
		fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
		return false;
	}
}
const DEFAULT_RESTART_HEALTH_ATTEMPTS = Math.ceil(6e4 / 500);
function hasListenerAttributionGap(portUsage) {
	if (portUsage.status !== "busy" || portUsage.listeners.length > 0) return false;
	if (portUsage.errors?.length) return true;
	return portUsage.hints.some((hint) => hint.includes("process details are unavailable"));
}
function listenerOwnedByRuntimePid(params) {
	return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
}
function looksLikeAuthClose(code, reason) {
	if (code !== 1008) return false;
	const normalized = (reason ?? "").toLowerCase();
	return normalized.includes("auth") || normalized.includes("token") || normalized.includes("password") || normalized.includes("scope") || normalized.includes("role");
}
async function confirmGatewayReachable(port) {
	const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || void 0;
	const password = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || void 0;
	const probe = await probeGateway({
		url: `ws://127.0.0.1:${port}`,
		auth: token || password ? {
			token,
			password
		} : void 0,
		timeoutMs: 1e3
	});
	return probe.ok || looksLikeAuthClose(probe.close?.code, probe.close?.reason);
}
async function inspectGatewayPortHealth(port) {
	let portUsage;
	try {
		portUsage = await inspectPortUsage(port);
	} catch (err) {
		portUsage = {
			port,
			status: "unknown",
			listeners: [],
			hints: [],
			errors: [String(err)]
		};
	}
	let healthy = false;
	if (portUsage.status === "busy") try {
		healthy = await confirmGatewayReachable(port);
	} catch {}
	return {
		portUsage,
		healthy
	};
}
async function inspectGatewayRestart(params) {
	const env = params.env ?? process.env;
	let runtime = { status: "unknown" };
	try {
		runtime = await params.service.readRuntime(env);
	} catch (err) {
		runtime = {
			status: "unknown",
			detail: String(err)
		};
	}
	let portUsage;
	try {
		portUsage = await inspectPortUsage(params.port);
	} catch (err) {
		portUsage = {
			port: params.port,
			status: "unknown",
			listeners: [],
			hints: [],
			errors: [String(err)]
		};
	}
	const gatewayListeners = portUsage.status === "busy" ? portUsage.listeners.filter((listener) => classifyPortListener(listener, params.port) === "gateway") : [];
	const fallbackListenerPids = params.includeUnknownListenersAsStale && process.platform === "win32" && runtime.status !== "running" && portUsage.status === "busy" ? portUsage.listeners.filter((listener) => classifyPortListener(listener, params.port) === "unknown").map((listener) => listener.pid).filter((pid) => Number.isFinite(pid)) : [];
	const running = runtime.status === "running";
	const runtimePid = runtime.pid;
	const listenerAttributionGap = hasListenerAttributionGap(portUsage);
	const ownsPort = runtimePid != null ? portUsage.listeners.some((listener) => listenerOwnedByRuntimePid({
		listener,
		runtimePid
	})) || listenerAttributionGap : gatewayListeners.length > 0 || listenerAttributionGap;
	let healthy = running && ownsPort;
	if (!healthy && running && portUsage.status === "busy") try {
		healthy = await confirmGatewayReachable(params.port);
	} catch {}
	const staleGatewayPids = Array.from(new Set([...gatewayListeners.filter((listener) => Number.isFinite(listener.pid)).filter((listener) => {
		if (!running) return true;
		if (runtimePid == null) return true;
		return !listenerOwnedByRuntimePid({
			listener,
			runtimePid
		});
	}).map((listener) => listener.pid), ...fallbackListenerPids.filter((pid) => runtime.pid == null || pid !== runtime.pid || !running)]));
	return {
		runtime,
		portUsage,
		healthy,
		staleGatewayPids
	};
}
async function waitForGatewayHealthyRestart(params) {
	const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
	const delayMs = params.delayMs ?? 500;
	let snapshot = await inspectGatewayRestart({
		service: params.service,
		port: params.port,
		env: params.env,
		includeUnknownListenersAsStale: params.includeUnknownListenersAsStale
	});
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (snapshot.healthy) return snapshot;
		if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") return snapshot;
		await sleep(delayMs);
		snapshot = await inspectGatewayRestart({
			service: params.service,
			port: params.port,
			env: params.env,
			includeUnknownListenersAsStale: params.includeUnknownListenersAsStale
		});
	}
	return snapshot;
}
async function waitForGatewayHealthyListener(params) {
	const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
	const delayMs = params.delayMs ?? 500;
	let snapshot = await inspectGatewayPortHealth(params.port);
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (snapshot.healthy) return snapshot;
		await sleep(delayMs);
		snapshot = await inspectGatewayPortHealth(params.port);
	}
	return snapshot;
}
function renderPortUsageDiagnostics(snapshot) {
	const lines = [];
	if (snapshot.portUsage.status === "busy") lines.push(...formatPortDiagnostics(snapshot.portUsage));
	else lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
	if (snapshot.portUsage.errors?.length) lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
	return lines;
}
function renderRestartDiagnostics(snapshot) {
	const lines = [];
	const runtimeSummary = [
		snapshot.runtime.status ? `status=${snapshot.runtime.status}` : null,
		snapshot.runtime.state ? `state=${snapshot.runtime.state}` : null,
		snapshot.runtime.pid != null ? `pid=${snapshot.runtime.pid}` : null,
		snapshot.runtime.lastExitStatus != null ? `lastExit=${snapshot.runtime.lastExitStatus}` : null
	].filter(Boolean).join(", ");
	if (runtimeSummary) lines.push(`Service runtime: ${runtimeSummary}`);
	lines.push(...renderPortUsageDiagnostics(snapshot));
	return lines;
}
function renderGatewayPortHealthDiagnostics(snapshot) {
	return renderPortUsageDiagnostics(snapshot);
}
async function terminateStaleGatewayPids(pids) {
	const targets = Array.from(new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0)));
	for (const pid of targets) killProcessTree(pid, { graceMs: 300 });
	if (targets.length > 0) await sleep(500);
	return targets;
}
//#endregion
//#region src/cli/daemon-cli/lifecycle.ts
const POST_RESTART_HEALTH_ATTEMPTS = DEFAULT_RESTART_HEALTH_ATTEMPTS;
const POST_RESTART_HEALTH_DELAY_MS = 500;
async function resolveGatewayLifecyclePort(service = resolveGatewayService()) {
	const command = await service.readCommand(process.env).catch(() => null);
	const serviceEnv = command?.environment ?? void 0;
	const mergedEnv = {
		...process.env,
		...serviceEnv ?? void 0
	};
	return parsePortFromArgs(command?.programArguments) ?? resolveGatewayPort(await readBestEffortConfig(), mergedEnv);
}
function extractWindowsCommandLine(raw) {
	const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (const line of lines) {
		if (!line.toLowerCase().startsWith("commandline=")) continue;
		return line.slice(12).trim() || null;
	}
	return lines.find((line) => line.toLowerCase() !== "commandline") ?? null;
}
function readGatewayProcessArgsSync(pid) {
	if (process.platform === "linux") try {
		return parseProcCmdline(fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
	} catch {
		return null;
	}
	if (process.platform === "darwin") {
		const ps = spawnSync("ps", [
			"-o",
			"command=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			timeout: 1e3
		});
		if (ps.error || ps.status !== 0) return null;
		const command = ps.stdout.trim();
		return command ? command.split(/\s+/) : null;
	}
	if (process.platform === "win32") {
		const wmic = spawnSync("wmic", [
			"process",
			"where",
			`ProcessId=${pid}`,
			"get",
			"CommandLine",
			"/value"
		], {
			encoding: "utf8",
			timeout: 1e3
		});
		if (wmic.error || wmic.status !== 0) return null;
		const command = extractWindowsCommandLine(wmic.stdout);
		return command ? parseCmdScriptCommandLine(command) : null;
	}
	return null;
}
function resolveGatewayListenerPids(port) {
	return Array.from(new Set(findGatewayPidsOnPortSync(port))).filter((pid) => Number.isFinite(pid) && pid > 0).filter((pid) => {
		const args = readGatewayProcessArgsSync(pid);
		return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
	});
}
function resolveGatewayPortFallback() {
	return readBestEffortConfig().then((cfg) => resolveGatewayPort(cfg, process.env)).catch(() => resolveGatewayPort(void 0, process.env));
}
function signalGatewayPid(pid, signal) {
	const args = readGatewayProcessArgsSync(pid);
	if (!args || !isGatewayArgv(args, { allowGatewayBinary: true })) throw new Error(`refusing to signal non-gateway process pid ${pid}`);
	process.kill(pid, signal);
}
function formatGatewayPidList(pids) {
	return pids.join(", ");
}
async function assertUnmanagedGatewayRestartEnabled(port) {
	const probe = await probeGateway({
		url: `ws://127.0.0.1:${port}`,
		auth: {
			token: process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || void 0,
			password: process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || void 0
		},
		timeoutMs: 1e3
	}).catch(() => null);
	if (!probe?.ok) return;
	if (!isRestartEnabled(probe.configSnapshot)) throw new Error("Gateway restart is disabled in the running gateway config (commands.restart=false); unmanaged SIGUSR1 restart would be ignored");
}
function resolveVerifiedGatewayListenerPids(port) {
	return resolveGatewayListenerPids(port).filter((pid) => Number.isFinite(pid) && pid > 0);
}
async function stopGatewayWithoutServiceManager(port) {
	const pids = resolveVerifiedGatewayListenerPids(port);
	if (pids.length === 0) return null;
	for (const pid of pids) signalGatewayPid(pid, "SIGTERM");
	return {
		result: "stopped",
		message: `Gateway stop signal sent to unmanaged process${pids.length === 1 ? "" : "es"} on port ${port}: ${formatGatewayPidList(pids)}.`
	};
}
async function restartGatewayWithoutServiceManager(port) {
	await assertUnmanagedGatewayRestartEnabled(port);
	const pids = resolveVerifiedGatewayListenerPids(port);
	if (pids.length === 0) return null;
	if (pids.length > 1) throw new Error(`multiple gateway processes are listening on port ${port}: ${formatGatewayPidList(pids)}; use "openclaw gateway status --deep" before retrying restart`);
	signalGatewayPid(pids[0], "SIGUSR1");
	return {
		result: "restarted",
		message: `Gateway restart signal sent to unmanaged process on port ${port}: ${pids[0]}.`
	};
}
async function runDaemonUninstall(opts = {}) {
	return await runServiceUninstall({
		serviceNoun: "Gateway",
		service: resolveGatewayService(),
		opts,
		stopBeforeUninstall: true,
		assertNotLoadedAfterUninstall: true
	});
}
async function runDaemonStart(opts = {}) {
	return await runServiceStart({
		serviceNoun: "Gateway",
		service: resolveGatewayService(),
		renderStartHints: renderGatewayServiceStartHints,
		opts
	});
}
async function runDaemonStop(opts = {}) {
	const service = resolveGatewayService();
	const gatewayPort = await resolveGatewayLifecyclePort(service).catch(() => resolveGatewayPortFallback());
	return await runServiceStop({
		serviceNoun: "Gateway",
		service,
		opts,
		onNotLoaded: async () => stopGatewayWithoutServiceManager(gatewayPort)
	});
}
/**
* Restart the gateway service service.
* @returns `true` if restart succeeded, `false` if the service was not loaded.
* Throws/exits on check or restart failures.
*/
async function runDaemonRestart(opts = {}) {
	const json = Boolean(opts.json);
	const service = resolveGatewayService();
	let restartedWithoutServiceManager = false;
	const restartPort = await resolveGatewayLifecyclePort(service).catch(() => resolveGatewayPortFallback());
	const restartWaitMs = POST_RESTART_HEALTH_ATTEMPTS * POST_RESTART_HEALTH_DELAY_MS;
	const restartWaitSeconds = Math.round(restartWaitMs / 1e3);
	return await runServiceRestart({
		serviceNoun: "Gateway",
		service,
		renderStartHints: renderGatewayServiceStartHints,
		opts,
		checkTokenDrift: true,
		onNotLoaded: async () => {
			const handled = await restartGatewayWithoutServiceManager(restartPort);
			if (handled) restartedWithoutServiceManager = true;
			return handled;
		},
		postRestartCheck: async ({ warnings, fail, stdout }) => {
			if (restartedWithoutServiceManager) {
				const health = await waitForGatewayHealthyListener({
					port: restartPort,
					attempts: POST_RESTART_HEALTH_ATTEMPTS,
					delayMs: POST_RESTART_HEALTH_DELAY_MS
				});
				if (health.healthy) return;
				const diagnostics = renderGatewayPortHealthDiagnostics(health);
				const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
				if (!json) {
					defaultRuntime.log(theme.warn(timeoutLine));
					for (const line of diagnostics) defaultRuntime.log(theme.muted(line));
				} else {
					warnings.push(timeoutLine);
					warnings.push(...diagnostics);
				}
				fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")]);
			}
			let health = await waitForGatewayHealthyRestart({
				service,
				port: restartPort,
				attempts: POST_RESTART_HEALTH_ATTEMPTS,
				delayMs: POST_RESTART_HEALTH_DELAY_MS,
				includeUnknownListenersAsStale: process.platform === "win32"
			});
			if (!health.healthy && health.staleGatewayPids.length > 0) {
				const staleMsg = `Found stale gateway process(es): ${health.staleGatewayPids.join(", ")}.`;
				warnings.push(staleMsg);
				if (!json) {
					defaultRuntime.log(theme.warn(staleMsg));
					defaultRuntime.log(theme.muted("Stopping stale process(es) and retrying restart..."));
				}
				await terminateStaleGatewayPids(health.staleGatewayPids);
				const retryRestart = await service.restart({
					env: process.env,
					stdout
				});
				if (retryRestart.outcome === "scheduled") return retryRestart;
				health = await waitForGatewayHealthyRestart({
					service,
					port: restartPort,
					attempts: POST_RESTART_HEALTH_ATTEMPTS,
					delayMs: POST_RESTART_HEALTH_DELAY_MS,
					includeUnknownListenersAsStale: process.platform === "win32"
				});
			}
			if (health.healthy) return;
			const diagnostics = renderRestartDiagnostics(health);
			const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
			const runningNoPortLine = health.runtime.status === "running" && health.portUsage.status === "free" ? `Gateway process is running but port ${restartPort} is still free (startup hang/crash loop or very slow VM startup).` : null;
			if (!json) {
				defaultRuntime.log(theme.warn(timeoutLine));
				if (runningNoPortLine) defaultRuntime.log(theme.warn(runningNoPortLine));
				for (const line of diagnostics) defaultRuntime.log(theme.muted(line));
			} else {
				warnings.push(timeoutLine);
				if (runningNoPortLine) warnings.push(runningNoPortLine);
				warnings.push(...diagnostics);
			}
			fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")]);
		}
	});
}
//#endregion
//#region src/daemon/diagnostics.ts
const GATEWAY_LOG_ERROR_PATTERNS = [
	/refusing to bind gateway/i,
	/gateway auth mode/i,
	/gateway start blocked/i,
	/failed to bind gateway socket/i,
	/tailscale .* requires/i
];
async function readLastLogLine(filePath) {
	try {
		const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/).map((line) => line.trim());
		for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i]) return lines[i];
		return null;
	} catch {
		return null;
	}
}
async function readLastGatewayErrorLine(env) {
	const { stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
	const stderrRaw = await fs.readFile(stderrPath, "utf8").catch(() => "");
	const stdoutRaw = await fs.readFile(stdoutPath, "utf8").catch(() => "");
	const lines = [...stderrRaw.split(/\r?\n/), ...stdoutRaw.split(/\r?\n/)].map((line) => line.trim());
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (!line) continue;
		if (GATEWAY_LOG_ERROR_PATTERNS.some((pattern) => pattern.test(line))) return line;
	}
	return await readLastLogLine(stderrPath) ?? await readLastLogLine(stdoutPath);
}
//#endregion
//#region src/daemon/inspect.ts
const EXTRA_MARKERS = [
	"openclaw",
	"clawdbot",
	"moltbot"
];
function renderGatewayServiceCleanupHints(env = process.env) {
	const profile = env.OPENCLAW_PROFILE;
	switch (process.platform) {
		case "darwin": {
			const label = resolveGatewayLaunchAgentLabel(profile);
			return [`launchctl bootout gui/$UID/${label}`, `rm ~/Library/LaunchAgents/${label}.plist`];
		}
		case "linux": {
			const unit = resolveGatewaySystemdServiceName(profile);
			return [`systemctl --user disable --now ${unit}.service`, `rm ~/.config/systemd/user/${unit}.service`];
		}
		case "win32": return [`schtasks /Delete /TN "${resolveGatewayWindowsTaskName(profile)}" /F`];
		default: return [];
	}
}
function resolveHomeDir(env) {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim();
	if (!home) throw new Error("Missing HOME");
	return home;
}
function detectMarker(content) {
	const lower = content.toLowerCase();
	for (const marker of EXTRA_MARKERS) if (lower.includes(marker)) return marker;
	return null;
}
function hasGatewayServiceMarker(content) {
	const lower = content.toLowerCase();
	const markerKeys = ["openclaw_service_marker"];
	const kindKeys = ["openclaw_service_kind"];
	const markerValues = [GATEWAY_SERVICE_MARKER.toLowerCase()];
	const hasMarkerKey = markerKeys.some((key) => lower.includes(key));
	const hasKindKey = kindKeys.some((key) => lower.includes(key));
	const hasMarkerValue = markerValues.some((value) => lower.includes(value));
	return hasMarkerKey && hasKindKey && hasMarkerValue && lower.includes("gateway".toLowerCase());
}
function isOpenClawGatewayLaunchdService(label, contents) {
	if (hasGatewayServiceMarker(contents)) return true;
	if (!contents.toLowerCase().includes("gateway")) return false;
	return label.startsWith("ai.openclaw.");
}
function isOpenClawGatewaySystemdService(name, contents) {
	if (hasGatewayServiceMarker(contents)) return true;
	if (!name.startsWith("openclaw-gateway")) return false;
	return contents.toLowerCase().includes("gateway");
}
function isOpenClawGatewayTaskName(name) {
	const normalized = name.trim().toLowerCase();
	if (!normalized) return false;
	return normalized === resolveGatewayWindowsTaskName().toLowerCase() || normalized.startsWith("openclaw gateway");
}
function tryExtractPlistLabel(contents) {
	const match = contents.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/i);
	if (!match) return null;
	return match[1]?.trim() || null;
}
function isIgnoredLaunchdLabel(label) {
	return label === resolveGatewayLaunchAgentLabel();
}
function isIgnoredSystemdName(name) {
	return name === resolveGatewaySystemdServiceName();
}
function isLegacyLabel(label) {
	const lower = label.toLowerCase();
	return lower.includes("clawdbot") || lower.includes("moltbot");
}
async function readDirEntries(dir) {
	try {
		return await fs.readdir(dir);
	} catch {
		return [];
	}
}
async function readUtf8File(filePath) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return null;
	}
}
async function collectServiceFiles(params) {
	const out = [];
	const entries = await readDirEntries(params.dir);
	for (const entry of entries) {
		if (!entry.endsWith(params.extension)) continue;
		const name = entry.slice(0, -params.extension.length);
		if (params.isIgnoredName(name)) continue;
		const fullPath = path.join(params.dir, entry);
		const contents = await readUtf8File(fullPath);
		if (contents === null) continue;
		out.push({
			entry,
			name,
			fullPath,
			contents
		});
	}
	return out;
}
async function scanLaunchdDir(params) {
	const results = [];
	const candidates = await collectServiceFiles({
		dir: params.dir,
		extension: ".plist",
		isIgnoredName: isIgnoredLaunchdLabel
	});
	for (const { name: labelFromName, fullPath, contents } of candidates) {
		const marker = detectMarker(contents);
		const label = tryExtractPlistLabel(contents) ?? labelFromName;
		if (!marker) {
			if (!(isLegacyLabel(labelFromName) || isLegacyLabel(label))) continue;
			results.push({
				platform: "darwin",
				label,
				detail: `plist: ${fullPath}`,
				scope: params.scope,
				marker: isLegacyLabel(label) ? "clawdbot" : "moltbot",
				legacy: true
			});
			continue;
		}
		if (isIgnoredLaunchdLabel(label)) continue;
		if (marker === "openclaw" && isOpenClawGatewayLaunchdService(label, contents)) continue;
		results.push({
			platform: "darwin",
			label,
			detail: `plist: ${fullPath}`,
			scope: params.scope,
			marker,
			legacy: marker !== "openclaw" || isLegacyLabel(label)
		});
	}
	return results;
}
async function scanSystemdDir(params) {
	const results = [];
	const candidates = await collectServiceFiles({
		dir: params.dir,
		extension: ".service",
		isIgnoredName: isIgnoredSystemdName
	});
	for (const { entry, name, fullPath, contents } of candidates) {
		const marker = detectMarker(contents);
		if (!marker) continue;
		if (marker === "openclaw" && isOpenClawGatewaySystemdService(name, contents)) continue;
		results.push({
			platform: "linux",
			label: entry,
			detail: `unit: ${fullPath}`,
			scope: params.scope,
			marker,
			legacy: marker !== "openclaw"
		});
	}
	return results;
}
function parseSchtasksList(output) {
	const tasks = [];
	let current = null;
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			if (current) {
				tasks.push(current);
				current = null;
			}
			continue;
		}
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		if (!value) continue;
		if (key === "taskname") {
			if (current) tasks.push(current);
			current = { name: value };
			continue;
		}
		if (!current) continue;
		if (key === "task to run") current.taskToRun = value;
	}
	if (current) tasks.push(current);
	return tasks;
}
async function findExtraGatewayServices(env, opts = {}) {
	const results = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (svc) => {
		const key = `${svc.platform}:${svc.label}:${svc.detail}:${svc.scope}`;
		if (seen.has(key)) return;
		seen.add(key);
		results.push(svc);
	};
	if (process.platform === "darwin") {
		try {
			const home = resolveHomeDir(env);
			const userDir = path.join(home, "Library", "LaunchAgents");
			for (const svc of await scanLaunchdDir({
				dir: userDir,
				scope: "user"
			})) push(svc);
			if (opts.deep) {
				for (const svc of await scanLaunchdDir({
					dir: path.join(path.sep, "Library", "LaunchAgents"),
					scope: "system"
				})) push(svc);
				for (const svc of await scanLaunchdDir({
					dir: path.join(path.sep, "Library", "LaunchDaemons"),
					scope: "system"
				})) push(svc);
			}
		} catch {
			return results;
		}
		return results;
	}
	if (process.platform === "linux") {
		try {
			const home = resolveHomeDir(env);
			const userDir = path.join(home, ".config", "systemd", "user");
			for (const svc of await scanSystemdDir({
				dir: userDir,
				scope: "user"
			})) push(svc);
			if (opts.deep) for (const dir of [
				"/etc/systemd/system",
				"/usr/lib/systemd/system",
				"/lib/systemd/system"
			]) for (const svc of await scanSystemdDir({
				dir,
				scope: "system"
			})) push(svc);
		} catch {
			return results;
		}
		return results;
	}
	if (process.platform === "win32") {
		if (!opts.deep) return results;
		const res = await execSchtasks([
			"/Query",
			"/FO",
			"LIST",
			"/V"
		]);
		if (res.code !== 0) return results;
		const tasks = parseSchtasksList(res.stdout);
		for (const task of tasks) {
			const name = task.name.trim();
			if (!name) continue;
			if (isOpenClawGatewayTaskName(name)) continue;
			const lowerName = name.toLowerCase();
			const lowerCommand = task.taskToRun?.toLowerCase() ?? "";
			let marker = null;
			for (const candidate of EXTRA_MARKERS) if (lowerName.includes(candidate) || lowerCommand.includes(candidate)) {
				marker = candidate;
				break;
			}
			if (!marker) continue;
			push({
				platform: "win32",
				label: name,
				detail: task.taskToRun ? `task: ${name}, run: ${task.taskToRun}` : name,
				scope: "system",
				marker,
				legacy: marker !== "openclaw"
			});
		}
		return results;
	}
	return results;
}
//#endregion
//#region src/gateway/probe-auth.ts
function buildGatewayProbeCredentialPolicy(params) {
	return {
		config: params.cfg,
		cfg: params.cfg,
		env: params.env,
		explicitAuth: params.explicitAuth,
		modeOverride: params.mode,
		mode: params.mode,
		includeLegacyEnv: false,
		remoteTokenFallback: "remote-only"
	};
}
async function resolveGatewayProbeAuthWithSecretInputs(params) {
	const policy = buildGatewayProbeCredentialPolicy(params);
	return await resolveGatewayCredentialsWithSecretInputs({
		config: policy.config,
		env: policy.env,
		explicitAuth: policy.explicitAuth,
		modeOverride: policy.modeOverride,
		includeLegacyEnv: policy.includeLegacyEnv,
		remoteTokenFallback: policy.remoteTokenFallback
	});
}
//#endregion
//#region src/cli/daemon-cli/probe.ts
async function probeGatewayStatus(opts) {
	try {
		await withProgress({
			label: "Checking gateway status...",
			indeterminate: true,
			enabled: opts.json !== true
		}, async () => await callGateway({
			url: opts.url,
			token: opts.token,
			password: opts.password,
			tlsFingerprint: opts.tlsFingerprint,
			method: "status",
			timeoutMs: opts.timeoutMs,
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			mode: GATEWAY_CLIENT_MODES.CLI,
			...opts.configPath ? { configPath: opts.configPath } : {}
		}));
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
//#region src/cli/daemon-cli/status.gather.ts
function shouldReportPortUsage(status, rpcOk) {
	if (status !== "busy") return false;
	if (rpcOk === true) return false;
	return true;
}
async function loadDaemonConfigContext(serviceEnv) {
	const mergedDaemonEnv = {
		...process.env,
		...serviceEnv ?? void 0
	};
	const cliConfigPath = resolveConfigPath(process.env, resolveStateDir(process.env));
	const daemonConfigPath = resolveConfigPath(mergedDaemonEnv, resolveStateDir(mergedDaemonEnv));
	const cliIO = createConfigIO({
		env: process.env,
		configPath: cliConfigPath
	});
	const daemonIO = createConfigIO({
		env: mergedDaemonEnv,
		configPath: daemonConfigPath
	});
	const [cliSnapshot, daemonSnapshot] = await Promise.all([cliIO.readConfigFileSnapshot().catch(() => null), daemonIO.readConfigFileSnapshot().catch(() => null)]);
	const cliCfg = cliIO.loadConfig();
	const daemonCfg = daemonIO.loadConfig();
	const cliConfigSummary = {
		path: cliSnapshot?.path ?? cliConfigPath,
		exists: cliSnapshot?.exists ?? false,
		valid: cliSnapshot?.valid ?? true,
		...cliSnapshot?.issues?.length ? { issues: cliSnapshot.issues } : {},
		controlUi: cliCfg.gateway?.controlUi
	};
	const daemonConfigSummary = {
		path: daemonSnapshot?.path ?? daemonConfigPath,
		exists: daemonSnapshot?.exists ?? false,
		valid: daemonSnapshot?.valid ?? true,
		...daemonSnapshot?.issues?.length ? { issues: daemonSnapshot.issues } : {},
		controlUi: daemonCfg.gateway?.controlUi
	};
	return {
		mergedDaemonEnv,
		cliCfg,
		daemonCfg,
		cliConfigSummary,
		daemonConfigSummary,
		configMismatch: cliConfigSummary.path !== daemonConfigSummary.path
	};
}
async function resolveGatewayStatusSummary(params) {
	const portFromArgs = parsePortFromArgs(params.commandProgramArguments);
	const daemonPort = portFromArgs ?? resolveGatewayPort(params.daemonCfg, params.mergedDaemonEnv);
	const portSource = portFromArgs ? "service args" : "env/config";
	const bindMode = params.daemonCfg.gateway?.bind ?? "loopback";
	const customBindHost = params.daemonCfg.gateway?.customBindHost;
	const bindHost = await resolveGatewayBindHost(bindMode, customBindHost);
	const probeHost = pickProbeHostForBind(bindMode, pickPrimaryTailnetIPv4(), customBindHost);
	const probeUrlOverride = trimToUndefined(params.rpcUrlOverride) ?? null;
	const scheme = params.daemonCfg.gateway?.tls?.enabled === true ? "wss" : "ws";
	const probeUrl = probeUrlOverride ?? `${scheme}://${probeHost}:${daemonPort}`;
	const probeNote = !probeUrlOverride && bindMode === "lan" ? `bind=lan listens on 0.0.0.0 (all interfaces); probing via ${probeHost}.` : !probeUrlOverride && bindMode === "loopback" ? "Loopback-only gateway; only local clients can connect." : void 0;
	return {
		gateway: {
			bindMode,
			bindHost,
			customBindHost,
			port: daemonPort,
			portSource,
			probeUrl,
			...probeNote ? { probeNote } : {}
		},
		daemonPort,
		cliPort: resolveGatewayPort(params.cliCfg, process.env),
		probeUrlOverride
	};
}
function toPortStatusSummary(diagnostics) {
	if (!diagnostics) return;
	return {
		port: diagnostics.port,
		status: diagnostics.status,
		listeners: diagnostics.listeners,
		hints: diagnostics.hints
	};
}
async function inspectDaemonPortStatuses(params) {
	const [portDiagnostics, portCliDiagnostics] = await Promise.all([inspectPortUsage(params.daemonPort).catch(() => null), params.cliPort !== params.daemonPort ? inspectPortUsage(params.cliPort).catch(() => null) : null]);
	return {
		portStatus: toPortStatusSummary(portDiagnostics),
		portCliStatus: toPortStatusSummary(portCliDiagnostics)
	};
}
async function gatherDaemonStatus(opts) {
	const service = resolveGatewayService();
	const [loaded, command, runtime] = await Promise.all([
		service.isLoaded({ env: process.env }).catch(() => false),
		service.readCommand(process.env).catch(() => null),
		service.readRuntime(process.env).catch((err) => ({
			status: "unknown",
			detail: String(err)
		}))
	]);
	const configAudit = await auditGatewayServiceConfig({
		env: process.env,
		command
	});
	const { mergedDaemonEnv, cliCfg, daemonCfg, cliConfigSummary, daemonConfigSummary, configMismatch } = await loadDaemonConfigContext(command?.environment ?? void 0);
	const { gateway, daemonPort, cliPort, probeUrlOverride } = await resolveGatewayStatusSummary({
		cliCfg,
		daemonCfg,
		mergedDaemonEnv,
		commandProgramArguments: command?.programArguments,
		rpcUrlOverride: opts.rpc.url
	});
	const { portStatus, portCliStatus } = await inspectDaemonPortStatuses({
		daemonPort,
		cliPort
	});
	const extraServices = await findExtraGatewayServices(process.env, { deep: Boolean(opts.deep) }).catch(() => []);
	const timeoutMs = parseStrictPositiveInteger(opts.rpc.timeout ?? "10000") ?? 1e4;
	const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
	const shouldUseLocalTlsRuntime = opts.probe && !probeUrlOverride && tlsEnabled;
	const tlsRuntime = shouldUseLocalTlsRuntime ? await loadGatewayTlsRuntime(daemonCfg.gateway?.tls) : void 0;
	const daemonProbeAuth = opts.probe ? await resolveGatewayProbeAuthWithSecretInputs({
		cfg: daemonCfg,
		mode: daemonCfg.gateway?.mode === "remote" ? "remote" : "local",
		env: mergedDaemonEnv,
		explicitAuth: {
			token: opts.rpc.token,
			password: opts.rpc.password
		}
	}) : void 0;
	const rpc = opts.probe ? await probeGatewayStatus({
		url: gateway.probeUrl,
		token: daemonProbeAuth?.token,
		password: daemonProbeAuth?.password,
		tlsFingerprint: shouldUseLocalTlsRuntime && tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : void 0,
		timeoutMs,
		json: opts.rpc.json,
		configPath: daemonConfigSummary.path
	}) : void 0;
	let lastError;
	if (loaded && runtime?.status === "running" && portStatus && portStatus.status !== "busy") lastError = await readLastGatewayErrorLine(mergedDaemonEnv) ?? void 0;
	return {
		service: {
			label: service.label,
			loaded,
			loadedText: service.loadedText,
			notLoadedText: service.notLoadedText,
			command,
			runtime,
			configAudit
		},
		config: {
			cli: cliConfigSummary,
			daemon: daemonConfigSummary,
			...configMismatch ? { mismatch: true } : {}
		},
		gateway,
		port: portStatus,
		...portCliStatus ? { portCli: portCliStatus } : {},
		lastError,
		...rpc ? { rpc: {
			...rpc,
			url: gateway.probeUrl
		} } : {},
		extraServices
	};
}
function renderPortDiagnosticsForCli(status, rpcOk) {
	if (!status.port || !shouldReportPortUsage(status.port.status, rpcOk)) return [];
	return formatPortDiagnostics({
		port: status.port.port,
		status: status.port.status,
		listeners: status.port.listeners,
		hints: status.port.hints
	});
}
function resolvePortListeningAddresses(status) {
	return Array.from(new Set(status.port?.listeners?.map((l) => l.address ? normalizeListenerAddress(l.address) : "").filter((v) => Boolean(v)) ?? []));
}
//#endregion
//#region src/cli/daemon-cli/status.print.ts
function sanitizeDaemonStatusForJson(status) {
	const command = status.service.command;
	if (!command?.environment) return status;
	const safeEnv = filterDaemonEnv(command.environment);
	const nextCommand = {
		...command,
		environment: Object.keys(safeEnv).length > 0 ? safeEnv : void 0
	};
	return {
		...status,
		service: {
			...status.service,
			command: nextCommand
		}
	};
}
function printDaemonStatus(status, opts) {
	if (opts.json) {
		const sanitized = sanitizeDaemonStatusForJson(status);
		defaultRuntime.log(JSON.stringify(sanitized, null, 2));
		return;
	}
	const { rich, label, accent, infoText, okText, warnText, errorText } = createCliStatusTextStyles();
	const spacer = () => defaultRuntime.log("");
	const { service, rpc, extraServices } = status;
	const serviceStatus = service.loaded ? okText(service.loadedText) : warnText(service.notLoadedText);
	defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);
	try {
		const logFile = getResolvedLoggerSettings().file;
		defaultRuntime.log(`${label("File logs:")} ${infoText(shortenHomePath(logFile))}`);
	} catch {}
	if (service.command?.programArguments?.length) defaultRuntime.log(`${label("Command:")} ${infoText(service.command.programArguments.join(" "))}`);
	if (service.command?.sourcePath) defaultRuntime.log(`${label("Service file:")} ${infoText(shortenHomePath(service.command.sourcePath))}`);
	if (service.command?.workingDirectory) defaultRuntime.log(`${label("Working dir:")} ${infoText(shortenHomePath(service.command.workingDirectory))}`);
	const daemonEnvLines = safeDaemonEnv(service.command?.environment);
	if (daemonEnvLines.length > 0) defaultRuntime.log(`${label("Service env:")} ${daemonEnvLines.join(" ")}`);
	spacer();
	if (service.configAudit?.issues.length) {
		defaultRuntime.error(warnText("Service config looks out of date or non-standard."));
		for (const issue of service.configAudit.issues) {
			const detail = issue.detail ? ` (${issue.detail})` : "";
			defaultRuntime.error(`${warnText("Service config issue:")} ${issue.message}${detail}`);
		}
		defaultRuntime.error(warnText(`Recommendation: run "${formatCliCommand("openclaw doctor")}" (or "${formatCliCommand("openclaw doctor --repair")}").`));
	}
	if (status.config) {
		const cliCfg = `${shortenHomePath(status.config.cli.path)}${status.config.cli.exists ? "" : " (missing)"}${status.config.cli.valid ? "" : " (invalid)"}`;
		defaultRuntime.log(`${label("Config (cli):")} ${infoText(cliCfg)}`);
		if (!status.config.cli.valid && status.config.cli.issues?.length) for (const issue of status.config.cli.issues.slice(0, 5)) defaultRuntime.error(`${errorText("Config issue:")} ${formatConfigIssueLine(issue, "", { normalizeRoot: true })}`);
		if (status.config.daemon) {
			const daemonCfg = `${shortenHomePath(status.config.daemon.path)}${status.config.daemon.exists ? "" : " (missing)"}${status.config.daemon.valid ? "" : " (invalid)"}`;
			defaultRuntime.log(`${label("Config (service):")} ${infoText(daemonCfg)}`);
			if (!status.config.daemon.valid && status.config.daemon.issues?.length) for (const issue of status.config.daemon.issues.slice(0, 5)) defaultRuntime.error(`${errorText("Service config issue:")} ${formatConfigIssueLine(issue, "", { normalizeRoot: true })}`);
		}
		if (status.config.mismatch) {
			defaultRuntime.error(errorText("Root cause: CLI and service are using different config paths (likely a profile/state-dir mismatch)."));
			defaultRuntime.error(errorText(`Fix: rerun \`${formatCliCommand("openclaw gateway install --force")}\` from the same --profile / OPENCLAW_STATE_DIR you expect.`));
		}
		spacer();
	}
	if (status.gateway) {
		const bindHost = status.gateway.bindHost ?? "n/a";
		defaultRuntime.log(`${label("Gateway:")} bind=${infoText(status.gateway.bindMode)} (${infoText(bindHost)}), port=${infoText(String(status.gateway.port))} (${infoText(status.gateway.portSource)})`);
		defaultRuntime.log(`${label("Probe target:")} ${infoText(status.gateway.probeUrl)}`);
		if (!(status.config?.daemon?.controlUi?.enabled ?? true)) defaultRuntime.log(`${label("Dashboard:")} ${warnText("disabled")}`);
		else {
			const links = resolveControlUiLinks({
				port: status.gateway.port,
				bind: status.gateway.bindMode,
				customBindHost: status.gateway.customBindHost,
				basePath: status.config?.daemon?.controlUi?.basePath
			});
			defaultRuntime.log(`${label("Dashboard:")} ${infoText(links.httpUrl)}`);
		}
		if (status.gateway.probeNote) defaultRuntime.log(`${label("Probe note:")} ${infoText(status.gateway.probeNote)}`);
		spacer();
	}
	const runtimeLine = formatRuntimeStatus(service.runtime);
	if (runtimeLine) {
		const runtimeColor = resolveRuntimeStatusColor(service.runtime?.status);
		defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
	}
	if (rpc && !rpc.ok && service.loaded && service.runtime?.status === "running") defaultRuntime.log(warnText("Warm-up: launch agents can take a few seconds. Try again shortly."));
	if (rpc) {
		if (rpc.ok) defaultRuntime.log(`${label("RPC probe:")} ${okText("ok")}`);
		else {
			defaultRuntime.error(`${label("RPC probe:")} ${errorText("failed")}`);
			if (rpc.url) defaultRuntime.error(`${label("RPC target:")} ${rpc.url}`);
			const lines = String(rpc.error ?? "unknown").split(/\r?\n/).filter(Boolean);
			for (const line of lines.slice(0, 12)) defaultRuntime.error(`  ${errorText(line)}`);
		}
		spacer();
	}
	if (process.platform === "linux" && isSystemdUnavailableDetail(service.runtime?.detail)) {
		defaultRuntime.error(errorText("systemd user services unavailable."));
		for (const hint of renderSystemdUnavailableHints({ wsl: isWSLEnv() })) defaultRuntime.error(errorText(hint));
		spacer();
	}
	if (service.runtime?.missingUnit) {
		defaultRuntime.error(errorText("Service unit not found."));
		for (const hint of renderRuntimeHints(service.runtime)) defaultRuntime.error(errorText(hint));
	} else if (service.loaded && service.runtime?.status === "stopped") {
		defaultRuntime.error(errorText("Service is loaded but not running (likely exited immediately)."));
		for (const hint of renderRuntimeHints(service.runtime, service.command?.environment ?? process.env)) defaultRuntime.error(errorText(hint));
		spacer();
	}
	if (service.runtime?.cachedLabel) {
		const labelValue = resolveGatewayLaunchAgentLabel((service.command?.environment ?? process.env).OPENCLAW_PROFILE);
		defaultRuntime.error(errorText(`LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${labelValue}`));
		defaultRuntime.error(errorText(`Then reinstall: ${formatCliCommand("openclaw gateway install")}`));
		spacer();
	}
	for (const line of renderPortDiagnosticsForCli(status, rpc?.ok)) defaultRuntime.error(errorText(line));
	if (status.port) {
		const addrs = resolvePortListeningAddresses(status);
		if (addrs.length > 0) defaultRuntime.log(`${label("Listening:")} ${infoText(addrs.join(", "))}`);
	}
	if (status.portCli && status.portCli.port !== status.port?.port) defaultRuntime.log(`${label("Note:")} CLI config resolves gateway port=${status.portCli.port} (${status.portCli.status}).`);
	if (service.loaded && service.runtime?.status === "running" && status.port && status.port.status !== "busy") {
		defaultRuntime.error(errorText(`Gateway port ${status.port.port} is not listening (service appears running).`));
		if (status.lastError) defaultRuntime.error(`${errorText("Last gateway error:")} ${status.lastError}`);
		if (process.platform === "linux") {
			const unit = resolveGatewaySystemdServiceName((service.command?.environment ?? process.env).OPENCLAW_PROFILE);
			defaultRuntime.error(errorText(`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`));
		} else if (process.platform === "darwin") {
			const logs = resolveGatewayLogPaths(service.command?.environment ?? process.env);
			defaultRuntime.error(`${errorText("Logs:")} ${shortenHomePath(logs.stdoutPath)}`);
			defaultRuntime.error(`${errorText("Errors:")} ${shortenHomePath(logs.stderrPath)}`);
		}
		spacer();
	}
	if (extraServices.length > 0) {
		defaultRuntime.error(errorText("Other gateway-like services detected (best effort):"));
		for (const svc of extraServices) defaultRuntime.error(`- ${errorText(svc.label)} (${svc.scope}, ${svc.detail})`);
		for (const hint of renderGatewayServiceCleanupHints()) defaultRuntime.error(`${errorText("Cleanup hint:")} ${hint}`);
		spacer();
	}
	if (extraServices.length > 0) {
		defaultRuntime.error(errorText("Recommendation: run a single gateway per machine for most setups. One gateway supports multiple agents (see docs: /gateway#multiple-gateways-same-host)."));
		defaultRuntime.error(errorText("If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host)."));
		spacer();
	}
	defaultRuntime.log(`${label("Troubles:")} run ${formatCliCommand("openclaw status")}`);
	defaultRuntime.log(`${label("Troubleshooting:")} https://docs.openclaw.ai/troubleshooting`);
}
//#endregion
//#region src/cli/daemon-cli/status.ts
async function runDaemonStatus(opts) {
	try {
		printDaemonStatus(await gatherDaemonStatus({
			rpc: opts.rpc,
			probe: Boolean(opts.probe),
			deep: Boolean(opts.deep)
		}), { json: Boolean(opts.json) });
	} catch (err) {
		const rich = isRich();
		defaultRuntime.error(colorize(rich, theme.error, `Gateway status failed: ${String(err)}`));
		defaultRuntime.exit(1);
	}
}
//#endregion
//#region src/cli/daemon-cli/register-service-commands.ts
function resolveInstallOptions(cmdOpts, command) {
	const parentForce = inheritOptionFromParent(command, "force");
	const parentPort = inheritOptionFromParent(command, "port");
	const parentToken = inheritOptionFromParent(command, "token");
	return {
		...cmdOpts,
		force: Boolean(cmdOpts.force || parentForce),
		port: cmdOpts.port ?? parentPort,
		token: cmdOpts.token ?? parentToken
	};
}
function resolveRpcOptions(cmdOpts, command) {
	const parentToken = inheritOptionFromParent(command, "token");
	const parentPassword = inheritOptionFromParent(command, "password");
	return {
		...cmdOpts,
		token: cmdOpts.token ?? parentToken,
		password: cmdOpts.password ?? parentPassword
	};
}
function addGatewayServiceCommands(parent, opts) {
	parent.command("status").description(opts?.statusDescription ?? "Show gateway service status + probe the Gateway").option("--url <url>", "Gateway WebSocket URL (defaults to config/remote/local)").option("--token <token>", "Gateway token (if required)").option("--password <password>", "Gateway password (password auth)").option("--timeout <ms>", "Timeout in ms", "10000").option("--no-probe", "Skip RPC probe").option("--deep", "Scan system-level services", false).option("--json", "Output JSON", false).action(async (cmdOpts, command) => {
		await runDaemonStatus({
			rpc: resolveRpcOptions(cmdOpts, command),
			probe: Boolean(cmdOpts.probe),
			deep: Boolean(cmdOpts.deep),
			json: Boolean(cmdOpts.json)
		});
	});
	parent.command("install").description("Install the Gateway service (launchd/systemd/schtasks)").option("--port <port>", "Gateway port").option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node").option("--token <token>", "Gateway token (token auth)").option("--force", "Reinstall/overwrite if already installed", false).option("--json", "Output JSON", false).action(async (cmdOpts, command) => {
		await runDaemonInstall(resolveInstallOptions(cmdOpts, command));
	});
	parent.command("uninstall").description("Uninstall the Gateway service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (cmdOpts) => {
		await runDaemonUninstall(cmdOpts);
	});
	parent.command("start").description("Start the Gateway service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (cmdOpts) => {
		await runDaemonStart(cmdOpts);
	});
	parent.command("stop").description("Stop the Gateway service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (cmdOpts) => {
		await runDaemonStop(cmdOpts);
	});
	parent.command("restart").description("Restart the Gateway service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (cmdOpts) => {
		await runDaemonRestart(cmdOpts);
	});
}
//#endregion
//#region src/cli/daemon-cli/register.ts
function registerDaemonCli(program) {
	addGatewayServiceCommands(program.command("daemon").description("Manage the Gateway service (launchd/systemd/schtasks)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`), { statusDescription: "Show service install status + probe the Gateway" });
}
//#endregion
export { addGatewayServiceCommands, registerDaemonCli, runDaemonInstall, runDaemonRestart, runDaemonStart, runDaemonStatus, runDaemonStop, runDaemonUninstall };
