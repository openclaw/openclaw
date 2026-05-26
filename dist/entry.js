#!/usr/bin/env node
import { i as normalizeEnv, t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { c as hasFlag, d as isRootHelpInvocation, f as isRootVersionInvocation, n as getCommandPathWithRootOptions, r as getCommandPositionalsWithRootOptions } from "./argv-j42r4Rb7.js";
import { t as isMainModule } from "./is-main-DoKHeRG7.js";
import { t as resolveCliArgvInvocation } from "./argv-invocation-C7Tq1otP.js";
import { a as resolveCliContainerTarget, i as parseCliContainerArgs, n as parseCliProfileArgs, t as applyCliProfileEnv } from "./profile-9JBJfDom.js";
import { t as normalizeWindowsArgv } from "./windows-argv-CVkWOV9N.js";
import { t as attachChildProcessBridge } from "./child-process-bridge-Lz6wlGQK.js";
import { t as resolveNodeStartupTlsEnvironment } from "./node-startup-env-DaD2c6bt.js";
import { t as ensureOpenClawExecMarkerOnProcess } from "./openclaw-exec-env-CjxcymgO.js";
import { t as installProcessWarningFilter } from "./warning-filter-Ek98bF5R.js";
import { enableCompileCache, getCompileCacheDir } from "node:module";
import process$1 from "node:process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
//#region src/entry.compile-cache.ts
const COMPILE_CACHE_RESPAWN_SIGNAL_EXIT_GRACE_MS = 1e3;
const COMPILE_CACHE_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS = 1e3;
function resolveEntryInstallRoot(entryFile) {
	const entryDir = path.dirname(entryFile);
	const entryParent = path.basename(entryDir);
	return entryParent === "dist" || entryParent === "src" ? path.dirname(entryDir) : entryDir;
}
function isSourceCheckoutInstallRoot(installRoot) {
	return existsSync(path.join(installRoot, ".git")) || existsSync(path.join(installRoot, "src", "entry.ts"));
}
function isNodeCompileCacheDisabled(env) {
	return env?.NODE_DISABLE_COMPILE_CACHE !== void 0;
}
function isNodeCompileCacheRequested(env) {
	return env?.NODE_COMPILE_CACHE !== void 0 && !isNodeCompileCacheDisabled(env);
}
function shouldEnableOpenClawCompileCache(params) {
	if (isNodeCompileCacheDisabled(params.env)) return false;
	return !isSourceCheckoutInstallRoot(params.installRoot);
}
function sanitizeCompileCachePathSegment(value) {
	const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	return normalized.length > 0 ? normalized : "unknown";
}
function readPackageVersion(packageJsonPath) {
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" && parsed.version.trim().length > 0) return parsed.version;
	} catch {}
	return "unknown";
}
function resolveOpenClawCompileCacheDirectory(params) {
	const env = params.env ?? process.env;
	const packageJsonPath = path.join(params.installRoot, "package.json");
	const version = sanitizeCompileCachePathSegment(readPackageVersion(packageJsonPath));
	let installMarker = "no-package-json";
	try {
		const stat = statSync(packageJsonPath);
		installMarker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
	} catch {}
	const baseDirectory = env.NODE_COMPILE_CACHE && !isNodeCompileCacheDisabled(env) ? env.NODE_COMPILE_CACHE : path.join(os.tmpdir(), "node-compile-cache");
	return path.join(baseDirectory, "openclaw", version, sanitizeCompileCachePathSegment(installMarker));
}
function buildOpenClawCompileCacheRespawnPlan(params) {
	const env = params.env ?? process.env;
	if (!isSourceCheckoutInstallRoot(params.installRoot)) return;
	if (env.OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED === "1") return;
	if (!params.compileCacheDir && !isNodeCompileCacheRequested(env)) return;
	const nextEnv = {
		...env,
		NODE_DISABLE_COMPILE_CACHE: "1",
		OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED: "1"
	};
	delete nextEnv.NODE_COMPILE_CACHE;
	return {
		command: params.execPath ?? process.execPath,
		args: [
			...params.execArgv ?? process.execArgv,
			params.currentFile,
			...(params.argv ?? process.argv).slice(2)
		],
		env: nextEnv
	};
}
function respawnWithoutOpenClawCompileCacheIfNeeded(params) {
	const plan = buildOpenClawCompileCacheRespawnPlan({
		currentFile: params.currentFile,
		installRoot: params.installRoot,
		compileCacheDir: getCompileCacheDir?.()
	});
	if (!plan) return false;
	runOpenClawCompileCacheRespawnPlan(plan);
	return true;
}
function runOpenClawCompileCacheRespawnPlan(plan, runtime = {
	spawn,
	attachChildProcessBridge,
	exit: process.exit.bind(process),
	writeError: (message) => process.stderr.write(message)
}) {
	const child = runtime.spawn(plan.command, plan.args, {
		stdio: "inherit",
		env: plan.env
	});
	let signalExitTimer;
	let signalForceKillTimer;
	const clearSignalExitTimer = () => {
		if (signalExitTimer) {
			clearTimeout(signalExitTimer);
			signalExitTimer = void 0;
		}
		if (signalForceKillTimer) {
			clearTimeout(signalForceKillTimer);
			signalForceKillTimer = void 0;
		}
	};
	const forceKillChild = () => {
		try {
			child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
		} catch {}
	};
	const requestChildTermination = () => {
		try {
			child.kill("SIGTERM");
		} catch {}
		signalForceKillTimer = setTimeout(() => {
			forceKillChild();
			runtime.exit(1);
		}, COMPILE_CACHE_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS);
		signalForceKillTimer.unref?.();
	};
	const scheduleParentExit = () => {
		if (signalExitTimer) return;
		signalExitTimer = setTimeout(() => {
			requestChildTermination();
		}, COMPILE_CACHE_RESPAWN_SIGNAL_EXIT_GRACE_MS);
		signalExitTimer.unref?.();
	};
	runtime.attachChildProcessBridge(child, { onSignal: scheduleParentExit });
	child.once("exit", (code, signal) => {
		clearSignalExitTimer();
		if (signal) runtime.exit(1);
		runtime.exit(code ?? 1);
	});
	child.once("error", (error) => {
		clearSignalExitTimer();
		runtime.writeError(`[openclaw] Failed to respawn CLI without compile cache: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		runtime.exit(1);
	});
	return child;
}
function enableOpenClawCompileCache(params) {
	if (!shouldEnableOpenClawCompileCache(params)) return;
	try {
		enableCompileCache(resolveOpenClawCompileCacheDirectory(params));
	} catch {}
}
//#endregion
//#region src/cli/respawn-policy.ts
const GATEWAY_RUN_BOOLEAN_FLAGS = [
	"--allow-unconfigured",
	"--claude-cli-logs",
	"--cli-backend-logs",
	"--compact",
	"--dev",
	"--force",
	"--raw-stream",
	"--reset",
	"--tailscale-reset-on-exit",
	"--verbose"
];
const GATEWAY_RUN_VALUE_FLAGS = [
	"--auth",
	"--bind",
	"--password",
	"--password-file",
	"--port",
	"--raw-stream-path",
	"--tailscale",
	"--token",
	"--ws-log"
];
const INTERACTIVE_TTY_COMMANDS = new Set([
	"tui",
	"terminal",
	"chat"
]);
function isForegroundGatewayRunArgv(argv) {
	const positionals = getCommandPositionalsWithRootOptions(argv, {
		commandPath: ["gateway"],
		booleanFlags: GATEWAY_RUN_BOOLEAN_FLAGS,
		valueFlags: GATEWAY_RUN_VALUE_FLAGS
	});
	if (!positionals) return false;
	return positionals.length === 0 || positionals.length === 1 && positionals[0] === "run";
}
function shouldSkipRespawnForArgv(argv) {
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.hasHelpOrVersion || invocation.primary !== null && INTERACTIVE_TTY_COMMANDS.has(invocation.primary) || invocation.primary === "gateway" && isForegroundGatewayRunArgv(argv);
}
function shouldSkipStartupEnvironmentRespawnForArgv(argv) {
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.hasHelpOrVersion || invocation.primary === "gateway" && isForegroundGatewayRunArgv(argv);
}
//#endregion
//#region src/entry.respawn.ts
const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
const OPENCLAW_NODE_OPTIONS_READY = "OPENCLAW_NODE_OPTIONS_READY";
const OPENCLAW_NODE_EXTRA_CA_CERTS_READY = "OPENCLAW_NODE_EXTRA_CA_CERTS_READY";
const CLI_RESPAWN_SIGNAL_EXIT_GRACE_MS = 1e3;
const CLI_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS = 1e3;
function pathModuleForPlatform(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}
function resolveCliRespawnCommand(params) {
	const basename = pathModuleForPlatform(params.platform ?? process.platform).basename(params.execPath).toLowerCase();
	if (basename === "volta-shim" || basename === "volta-shim.exe") return "node";
	return params.execPath;
}
function hasExperimentalWarningSuppressed(params = {}) {
	const env = params.env ?? process.env;
	const execArgv = params.execArgv ?? process.execArgv;
	const nodeOptions = env.NODE_OPTIONS ?? "";
	if (nodeOptions.includes("--disable-warning=ExperimentalWarning") || nodeOptions.includes("--no-warnings")) return true;
	return execArgv.some((arg) => arg === "--disable-warning=ExperimentalWarning" || arg === "--no-warnings");
}
function buildCliRespawnPlan(params = {}) {
	const argv = params.argv ?? process.argv;
	const env = params.env ?? process.env;
	const execArgv = params.execArgv ?? process.execArgv;
	const execPath = params.execPath ?? process.execPath;
	const platform = params.platform ?? process.platform;
	if (shouldSkipStartupEnvironmentRespawnForArgv(argv) || isTruthyEnvValue(env.OPENCLAW_NO_RESPAWN)) return null;
	if (platform === "win32") return null;
	const childEnv = { ...env };
	const childExecArgv = [...execArgv];
	let needsRespawn = false;
	const autoNodeExtraCaCerts = params.autoNodeExtraCaCerts ?? resolveNodeStartupTlsEnvironment({
		env,
		execPath,
		includeDarwinDefaults: false
	}).NODE_EXTRA_CA_CERTS;
	if (autoNodeExtraCaCerts && !isTruthyEnvValue(env["OPENCLAW_NODE_EXTRA_CA_CERTS_READY"]) && !env.NODE_EXTRA_CA_CERTS) {
		childEnv.NODE_EXTRA_CA_CERTS = autoNodeExtraCaCerts;
		childEnv[OPENCLAW_NODE_EXTRA_CA_CERTS_READY] = "1";
		needsRespawn = true;
	}
	if (!shouldSkipRespawnForArgv(argv) && !isTruthyEnvValue(env["OPENCLAW_NODE_OPTIONS_READY"]) && !hasExperimentalWarningSuppressed({
		env,
		execArgv
	})) {
		childEnv[OPENCLAW_NODE_OPTIONS_READY] = "1";
		childExecArgv.unshift(EXPERIMENTAL_WARNING_FLAG);
		needsRespawn = true;
	}
	if (!needsRespawn) return null;
	return {
		command: resolveCliRespawnCommand({
			execPath,
			platform
		}),
		argv: [...childExecArgv, ...argv.slice(1)],
		env: childEnv
	};
}
function runCliRespawnPlan(plan, runtime = {
	spawn,
	attachChildProcessBridge,
	exit: process.exit.bind(process),
	writeError: (message, error) => console.error(message, error)
}) {
	const child = runtime.spawn(plan.command, plan.argv, {
		stdio: "inherit",
		env: plan.env
	});
	let signalExitTimer;
	let signalForceKillTimer;
	const clearSignalTimers = () => {
		if (signalExitTimer) {
			clearTimeout(signalExitTimer);
			signalExitTimer = void 0;
		}
		if (signalForceKillTimer) {
			clearTimeout(signalForceKillTimer);
			signalForceKillTimer = void 0;
		}
	};
	const forceKillChild = () => {
		try {
			child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
		} catch {}
	};
	const requestChildTermination = () => {
		try {
			child.kill("SIGTERM");
		} catch {}
		signalForceKillTimer = setTimeout(() => {
			forceKillChild();
			runtime.exit(1);
		}, CLI_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS);
		signalForceKillTimer.unref?.();
	};
	const scheduleParentExit = () => {
		if (signalExitTimer) return;
		signalExitTimer = setTimeout(() => {
			requestChildTermination();
		}, CLI_RESPAWN_SIGNAL_EXIT_GRACE_MS);
		signalExitTimer.unref?.();
	};
	runtime.attachChildProcessBridge(child, { onSignal: scheduleParentExit });
	child.once("exit", (code, signal) => {
		clearSignalTimers();
		if (signal) {
			runtime.exit(1);
			return;
		}
		runtime.exit(code ?? 1);
	});
	child.once("error", (error) => {
		clearSignalTimers();
		runtime.writeError("[openclaw] Failed to respawn CLI:", error instanceof Error ? error.stack ?? error.message : error);
		runtime.exit(1);
	});
	return child;
}
//#endregion
//#region src/entry.version-fast-path.ts
function tryHandleRootVersionFastPath(argv, deps = {}) {
	if (resolveCliContainerTarget(argv, deps.env)) return false;
	if (!isRootVersionInvocation(argv)) return false;
	const output = deps.output ?? ((message) => console.log(message));
	const exit = deps.exit ?? ((code) => process.exit(code));
	const onError = deps.onError ?? ((error) => {
		console.error("[openclaw] Failed to resolve version:", error instanceof Error ? error.stack ?? error.message : error);
		process.exitCode = 1;
	});
	(deps.resolveVersion ?? (async () => {
		const [{ VERSION }, { resolveCommitHash }] = await Promise.all([import("./version-DADH-5s2.js"), import("./git-commit-D1sXRBUZ.js")]);
		return {
			VERSION,
			resolveCommitHash
		};
	}))().then(({ VERSION, resolveCommitHash }) => {
		const commit = resolveCommitHash({ moduleUrl: deps.moduleUrl ?? import.meta.url });
		output(commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`);
		exit(0);
	}).catch(onError);
	return true;
}
//#endregion
//#region src/entry.ts
const ENTRY_WRAPPER_PAIRS = [{
	wrapperBasename: "openclaw.mjs",
	entryBasename: "entry.js"
}, {
	wrapperBasename: "openclaw.js",
	entryBasename: "entry.js"
}];
function shouldForceReadOnlyAuthStore(argv) {
	const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
	for (let index = 0; index < tokens.length - 1; index += 1) if (tokens[index] === "secrets" && tokens[index + 1] === "audit") return true;
	return false;
}
function createGatewayEntryStartupTrace(argv) {
	const enabled = isTruthyEnvValue(process$1.env.OPENCLAW_GATEWAY_STARTUP_TRACE) && argv.slice(2).includes("gateway");
	const started = performance.now();
	let last = started;
	const emit = (name, durationMs, totalMs) => {
		if (!enabled) return;
		process$1.stderr.write(`[gateway] startup trace: entry.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`);
	};
	return {
		mark(name) {
			const now = performance.now();
			emit(name, now - last, now - started);
			last = now;
		},
		async measure(name, run) {
			const before = performance.now();
			try {
				return await run();
			} finally {
				const now = performance.now();
				emit(name, now - before, now - started);
				last = now;
			}
		}
	};
}
const gatewayEntryStartupTrace = createGatewayEntryStartupTrace(process$1.argv);
if (!isMainModule({
	currentFile: fileURLToPath(import.meta.url),
	wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS]
})) {} else {
	const entryFile = fileURLToPath(import.meta.url);
	const installRoot = resolveEntryInstallRoot(entryFile);
	if (!respawnWithoutOpenClawCompileCacheIfNeeded({
		currentFile: entryFile,
		installRoot
	})) {
		process$1.title = "openclaw";
		ensureOpenClawExecMarkerOnProcess();
		installProcessWarningFilter();
		normalizeEnv();
		enableOpenClawCompileCache({ installRoot });
		gatewayEntryStartupTrace.mark("bootstrap");
		if (shouldForceReadOnlyAuthStore(process$1.argv)) process$1.env.OPENCLAW_AUTH_STORE_READONLY = "1";
		if (process$1.argv.includes("--no-color")) {
			process$1.env.NO_COLOR = "1";
			process$1.env.FORCE_COLOR = "0";
		}
		function ensureCliRespawnReady() {
			const plan = buildCliRespawnPlan();
			if (!plan) return false;
			runCliRespawnPlan(plan);
			return true;
		}
		process$1.argv = normalizeWindowsArgv(process$1.argv);
		if (!ensureCliRespawnReady()) {
			const parsedContainer = parseCliContainerArgs(process$1.argv);
			if (!parsedContainer.ok) {
				console.error(`[openclaw] ${parsedContainer.error}`);
				process$1.exit(2);
			}
			const parsed = parseCliProfileArgs(parsedContainer.argv);
			if (!parsed.ok) {
				console.error(`[openclaw] ${parsed.error}`);
				process$1.exit(2);
			}
			if (resolveCliContainerTarget(process$1.argv) && parsed.profile) {
				console.error("[openclaw] --container cannot be combined with --profile/--dev");
				process$1.exit(2);
			}
			if (parsed.profile) {
				applyCliProfileEnv({ profile: parsed.profile });
				process$1.argv = parsed.argv;
			}
			gatewayEntryStartupTrace.mark("argv");
			if (!tryHandleRootVersionFastPath(process$1.argv)) await runMainOrRootHelp(process$1.argv);
		}
	}
}
async function tryHandleRootHelpFastPath(argv, deps = {}) {
	if (resolveCliContainerTarget(argv, deps.env)) return false;
	if (!isRootHelpInvocation(argv)) return false;
	const handleError = deps.onError ?? ((error) => {
		console.error("[openclaw] Failed to display help:", error instanceof Error ? error.stack ?? error.message : error);
		process$1.exitCode = 1;
	});
	try {
		const liveRootHelpOptions = await (deps.loadRootHelpRenderOptionsForConfigSensitivePlugins ?? (await import("./root-help-live-config-3vxSmcK6.js")).loadRootHelpRenderOptionsForConfigSensitivePlugins)(deps.env);
		if (!liveRootHelpOptions) {
			if ((deps.outputPrecomputedRootHelpText ?? (await import("./root-help-metadata-BihbOLGR.js")).outputPrecomputedRootHelpText)()) return true;
		}
		await (deps.outputRootHelp ?? (await import("./root-help-CxFRRMAh.js")).outputRootHelp)(liveRootHelpOptions ?? void 0);
		return true;
	} catch (error) {
		handleError(error);
		return true;
	}
}
function resolvePrecomputedCommandHelpName(argv) {
	if (!hasFlag(argv, "--help") && !hasFlag(argv, "-h")) return null;
	const commandPath = getCommandPathWithRootOptions(argv, 2);
	if (commandPath.length !== 1) return null;
	const [commandName] = commandPath;
	if (commandName === "browser" || commandName === "secrets" || commandName === "nodes") return commandName;
	return null;
}
async function tryHandlePrecomputedCommandHelpFastPath(argv, deps = {}) {
	const env = deps.env ?? process$1.env;
	if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") return false;
	if (resolveCliContainerTarget(argv, env)) return false;
	const commandName = resolvePrecomputedCommandHelpName(argv);
	if (!commandName) return false;
	try {
		if (commandName === "nodes") {
			if (await (deps.loadRootHelpRenderOptionsForConfigSensitivePlugins ?? (await import("./root-help-live-config-3vxSmcK6.js")).loadRootHelpRenderOptionsForConfigSensitivePlugins)(env)) return false;
		}
		if (commandName === "browser") return (deps.outputPrecomputedBrowserHelpText ?? (await import("./root-help-metadata-BihbOLGR.js")).outputPrecomputedBrowserHelpText)();
		if (commandName === "secrets") return (deps.outputPrecomputedSecretsHelpText ?? (await import("./root-help-metadata-BihbOLGR.js")).outputPrecomputedSecretsHelpText)();
		return (deps.outputPrecomputedNodesHelpText ?? (await import("./root-help-metadata-BihbOLGR.js")).outputPrecomputedNodesHelpText)();
	} catch {
		return false;
	}
}
async function runMainOrRootHelp(argv) {
	if (await tryHandleRootHelpFastPath(argv)) return;
	if (await tryHandlePrecomputedCommandHelpFastPath(argv)) return;
	try {
		const { runCli } = await gatewayEntryStartupTrace.measure("run-main-import", () => import("./cli/run-main.js"));
		await runCli(argv);
	} catch (error) {
		const { formatCliFailureLines } = await import("./failure-output-DpvzkRSd.js");
		for (const line of formatCliFailureLines({
			title: "Could not start the CLI.",
			error,
			argv
		})) console.error(line);
		process$1.exit(1);
	}
}
//#endregion
export { tryHandlePrecomputedCommandHelpFastPath, tryHandleRootHelpFastPath };
