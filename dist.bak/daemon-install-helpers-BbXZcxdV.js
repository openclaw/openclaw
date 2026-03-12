import { t as formatCliCommand } from "./command-format-ChfKqObn.js";
import { n as collectConfigServiceEnvVars, r as VERSION } from "./env-vars-Duxu9t5m.js";
import { _ as resolveNodeWindowsTaskName, a as NODE_SERVICE_KIND, f as resolveGatewaySystemdServiceName, g as resolveNodeSystemdServiceName, h as resolveNodeLaunchAgentLabel, l as resolveGatewayLaunchAgentLabel, n as GATEWAY_SERVICE_KIND, o as NODE_SERVICE_MARKER, r as GATEWAY_SERVICE_MARKER, s as NODE_WINDOWS_TASK_SCRIPT_NAME } from "./constants-DHS1Cz8G.js";
import { n as isSupportedNodeVersion } from "./runtime-guard-C-Xp_TV0.js";
import { n as isNodeRuntime, t as isBunRuntime } from "./runtime-binary-xByxn2JX.js";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";

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
		throw new Error("Node not found in PATH. Install Node 22+.");
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
async function resolveNodeProgramArguments(params) {
	const args = [
		"node",
		"run",
		"--host",
		params.host,
		"--port",
		String(params.port)
	];
	if (params.tls || params.tlsFingerprint) args.push("--tls");
	if (params.tlsFingerprint) args.push("--tls-fingerprint", params.tlsFingerprint);
	if (params.nodeId) args.push("--node-id", params.nodeId);
	if (params.displayName) args.push("--display-name", params.displayName);
	return resolveCliProgramArguments({
		args,
		dev: params.dev,
		runtime: params.runtime,
		nodePath: params.nodePath
	});
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
	return `System Node ${versionLabel} at ${systemNode.path} is below the required Node 22+.${selectedLabel} Install Node 22+ from nodejs.org or Homebrew.`;
}
async function resolvePreferredNodePath(params) {
	if (params.runtime !== "node") return;
	const platform = params.platform ?? process.platform;
	const currentExecPath = params.execPath ?? process.execPath;
	if (currentExecPath && isNodeExecPath(currentExecPath, platform)) {
		if (isSupportedNodeVersion(await resolveNodeVersion(currentExecPath, params.execFile ?? execFileAsync))) return currentExecPath;
	}
	const systemNode = await resolveSystemNodeInfo(params);
	if (!systemNode?.supported) return;
	return systemNode.path;
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
	const { env, port, token, launchdLabel } = params;
	const platform = params.platform ?? process.platform;
	const profile = env.OPENCLAW_PROFILE;
	const resolvedLaunchdLabel = launchdLabel || (platform === "darwin" ? resolveGatewayLaunchAgentLabel(profile) : void 0);
	const systemdUnit = `${resolveGatewaySystemdServiceName(profile)}.service`;
	const stateDir = env.OPENCLAW_STATE_DIR;
	const configPath = env.OPENCLAW_CONFIG_PATH;
	const tmpDir = env.TMPDIR?.trim() || os.tmpdir();
	const proxyEnv = readServiceProxyEnvironment(env);
	const nodeCaCerts = env.NODE_EXTRA_CA_CERTS ?? (platform === "darwin" ? "/etc/ssl/cert.pem" : void 0);
	return {
		HOME: env.HOME,
		TMPDIR: tmpDir,
		PATH: buildMinimalServicePath({ env }),
		...proxyEnv,
		NODE_EXTRA_CA_CERTS: nodeCaCerts,
		OPENCLAW_PROFILE: profile,
		OPENCLAW_STATE_DIR: stateDir,
		OPENCLAW_CONFIG_PATH: configPath,
		OPENCLAW_GATEWAY_PORT: String(port),
		OPENCLAW_GATEWAY_TOKEN: token,
		OPENCLAW_LAUNCHD_LABEL: resolvedLaunchdLabel,
		OPENCLAW_SYSTEMD_UNIT: systemdUnit,
		OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
		OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
		OPENCLAW_SERVICE_VERSION: VERSION
	};
}
function buildNodeServiceEnvironment(params) {
	const { env } = params;
	const platform = params.platform ?? process.platform;
	const stateDir = env.OPENCLAW_STATE_DIR;
	const configPath = env.OPENCLAW_CONFIG_PATH;
	const tmpDir = env.TMPDIR?.trim() || os.tmpdir();
	const proxyEnv = readServiceProxyEnvironment(env);
	const nodeCaCerts = env.NODE_EXTRA_CA_CERTS ?? (platform === "darwin" ? "/etc/ssl/cert.pem" : void 0);
	return {
		HOME: env.HOME,
		TMPDIR: tmpDir,
		PATH: buildMinimalServicePath({ env }),
		...proxyEnv,
		NODE_EXTRA_CA_CERTS: nodeCaCerts,
		OPENCLAW_STATE_DIR: stateDir,
		OPENCLAW_CONFIG_PATH: configPath,
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

//#endregion
//#region src/commands/daemon-install-runtime-warning.ts
async function emitNodeRuntimeWarning(params) {
	if (params.runtime !== "node") return;
	const warning = renderSystemNodeWarning(await resolveSystemNodeInfo({ env: params.env }), params.nodeProgram);
	if (warning) params.warn?.(warning, params.title);
}

//#endregion
//#region src/commands/daemon-install-helpers.ts
function resolveGatewayDevMode(argv = process.argv) {
	const normalizedEntry = argv[1]?.replaceAll("\\", "/");
	return Boolean(normalizedEntry?.includes("/src/") && normalizedEntry.endsWith(".ts"));
}
async function buildGatewayInstallPlan(params) {
	const devMode = params.devMode ?? resolveGatewayDevMode();
	const nodePath = params.nodePath ?? await resolvePreferredNodePath({
		env: params.env,
		runtime: params.runtime
	});
	const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
		port: params.port,
		dev: devMode,
		runtime: params.runtime,
		nodePath
	});
	await emitNodeRuntimeWarning({
		env: params.env,
		runtime: params.runtime,
		nodeProgram: programArguments[0],
		warn: params.warn,
		title: "Gateway runtime"
	});
	const serviceEnvironment = buildServiceEnvironment({
		env: params.env,
		port: params.port,
		token: params.token,
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
function gatewayInstallErrorHint(platform = process.platform) {
	return platform === "win32" ? "Tip: rerun from an elevated PowerShell (Start → type PowerShell → right-click → Run as administrator) or skip service install." : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}

//#endregion
export { buildNodeServiceEnvironment as a, isVersionManagedNodePath as c, resolveSystemNodeInfo as d, resolveSystemNodePath as f, emitNodeRuntimeWarning as i, renderSystemNodeWarning as l, gatewayInstallErrorHint as n, getMinimalServicePathPartsFromEnv as o, resolveNodeProgramArguments as p, resolveGatewayDevMode as r, isSystemNodePath as s, buildGatewayInstallPlan as t, resolvePreferredNodePath as u };