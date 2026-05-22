import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "../string-coerce-Bje8XVt9.js";
import { h as getSubCliEntries, v as getCoreCliCommandNames } from "../argv-DLAsQBp6.js";
import { v as resolveStateDir } from "../paths-C1_Y0cDn.js";
import { t as isMainModule } from "../is-main-BEaTwLZn.js";
import { t as resolveCliArgvInvocation } from "../argv-invocation-BqQrcVeY.js";
import { a as parseCliContainerArgs, i as maybeRunCliInContainer, n as applyCliProfileEnv, r as parseCliProfileArgs, t as normalizeWindowsArgv } from "../windows-argv-BoKqJSLr.js";
import { i as normalizeEnv, t as isTruthyEnvValue } from "../env-p2fClQGo.js";
import { n as resolveManifestCommandAliasOwnerInRegistry } from "../manifest-command-aliases-DG129CVi.js";
import { t as assertSupportedRuntime } from "../runtime-guard-C3Y1NNt6.js";
import { t as ensureOpenClawCliOnPath } from "../path-env-Dj-Ap8AH.js";
import { a as shouldSkipPluginCommandRegistration, r as shouldRegisterPrimaryCommandOnly, t as isReservedNonPluginCommandRoot } from "../command-registration-policy-DlvDyalO.js";
import { a as consumeGatewayFastPathRootOptionToken, n as resolveCliNetworkProxyPolicy, o as consumeGatewayRunOptionToken, t as resolveCliCommandPathPolicy } from "../command-path-policy-qJwawqsG.js";
import process$1 from "node:process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
//#region src/cli/run-main-policy.ts
const ROOT_HELP_ALIASES = new Set(["tools"]);
function rewriteUpdateFlagArgv(argv) {
	const index = argv.indexOf("--update");
	if (index === -1) return argv;
	const next = [...argv];
	next.splice(index, 1, "update");
	return next;
}
function shouldEnsureCliPath(argv) {
	const invocation = resolveCliArgvInvocation(argv);
	if (invocation.hasHelpOrVersion || shouldStartCrestodianForBareRoot(argv)) return false;
	return resolveCliCommandPathPolicy(invocation.commandPath).ensureCliPath;
}
function shouldUseRootHelpFastPath(argv, env = process.env) {
	const invocation = resolveCliArgvInvocation(argv);
	return env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH !== "1" && (invocation.isRootHelpInvocation || invocation.commandPath.length === 1 && ROOT_HELP_ALIASES.has(invocation.commandPath[0] ?? "") && invocation.hasHelpOrVersion || invocation.commandPath.length === 1 && invocation.commandPath[0] === "help" && invocation.hasHelpOrVersion);
}
function shouldUseBrowserHelpFastPath(argv, env = process.env) {
	if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") return false;
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.commandPath.length === 1 && invocation.commandPath[0] === "browser" && invocation.hasHelpOrVersion;
}
function shouldStartCrestodianForBareRoot(argv) {
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.commandPath.length === 0 && !invocation.hasHelpOrVersion;
}
function shouldStartCrestodianForModernOnboard(argv) {
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.commandPath[0] === "onboard" && argv.includes("--modern") && !invocation.hasHelpOrVersion;
}
function shouldStartProxyForCli(argv) {
	const policyArgv = rewriteUpdateFlagArgv(argv);
	const invocation = resolveCliArgvInvocation(policyArgv);
	const [primary] = invocation.commandPath;
	if (invocation.hasHelpOrVersion || !primary) return false;
	return resolveCliNetworkProxyPolicy(policyArgv) === "default";
}
function resolveMissingPluginCommandMessage$1(pluginId, config, options) {
	const normalizedPluginId = normalizeLowercaseStringOrEmpty(pluginId);
	if (!normalizedPluginId) return null;
	const allow = Array.isArray(config?.plugins?.allow) && config.plugins.allow.length > 0 ? config.plugins.allow.filter((entry) => typeof entry === "string").map((entry) => normalizeOptionalLowercaseString(entry)).filter(Boolean) : [];
	const commandAlias = options?.registry ? resolveManifestCommandAliasOwnerInRegistry({
		command: normalizedPluginId,
		registry: options.registry
	}) : options?.resolveCommandAliasOwner?.({
		command: normalizedPluginId,
		config,
		...options?.registry ? { registry: options.registry } : {}
	});
	const parentPluginId = commandAlias?.pluginId;
	if (parentPluginId) {
		if (allow.length > 0 && !allow.includes(parentPluginId)) return `"${normalizedPluginId}" is not a plugin; it is a command provided by the "${parentPluginId}" plugin. Add "${parentPluginId}" to \`plugins.allow\` instead of "${normalizedPluginId}".`;
		if (config?.plugins?.entries?.[parentPluginId]?.enabled === false) return `The \`openclaw ${normalizedPluginId}\` command is unavailable because \`plugins.entries.${parentPluginId}.enabled=false\`. Re-enable that entry if you want the bundled plugin command surface.`;
		if (commandAlias.kind !== "runtime-slash" && commandAlias.enabledByDefault !== true && config?.plugins?.entries?.[parentPluginId]?.enabled !== true) return `The \`openclaw ${normalizedPluginId}\` command is provided by the "${parentPluginId}" plugin, but that bundled plugin is disabled by default. Run \`openclaw plugins enable ${parentPluginId}\` to enable that CLI surface.`;
		if (commandAlias.kind === "runtime-slash") return `"${normalizedPluginId}" is a runtime slash command (/${normalizedPluginId}), not a CLI command. It is provided by the "${parentPluginId}" plugin. ${commandAlias.cliCommand ? `Use \`openclaw ${commandAlias.cliCommand}\` for related CLI operations, or ` : "Use "}\`/${normalizedPluginId}\` in a chat session.`;
	}
	if (isReservedNonPluginCommandRoot(normalizedPluginId)) return null;
	if (allow.length > 0 && !allow.includes(normalizedPluginId)) {
		if (parentPluginId && allow.includes(parentPluginId)) return null;
		return `The \`openclaw ${normalizedPluginId}\` command is unavailable because \`plugins.allow\` excludes "${normalizedPluginId}". Add "${normalizedPluginId}" to \`plugins.allow\` if you want that bundled plugin CLI surface.`;
	}
	if (config?.plugins?.entries?.[normalizedPluginId]?.enabled === false) return `The \`openclaw ${normalizedPluginId}\` command is unavailable because \`plugins.entries.${normalizedPluginId}.enabled=false\`. Re-enable that entry if you want the bundled plugin CLI surface.`;
	return null;
}
//#endregion
//#region src/cli/run-main.ts
const CLI_PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy"
];
function createGatewayCliMainStartupTrace(argv) {
	const enabled = isTruthyEnvValue(process$1.env.OPENCLAW_GATEWAY_STARTUP_TRACE) && argv.slice(2).includes("gateway");
	const started = performance.now();
	let last = started;
	const emit = (name, durationMs, totalMs) => {
		if (!enabled) return;
		process$1.stderr.write(`[gateway] startup trace: cli.main.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`);
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
function isGatewayRunFastPathArgv(argv) {
	if (resolveCliArgvInvocation(argv).hasHelpOrVersion) return false;
	const args = argv.slice(2);
	let sawGateway = false;
	let sawRun = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg || arg === "--") return false;
		if (!sawGateway) {
			const consumed = consumeGatewayFastPathRootOptionToken(args, index);
			if (consumed > 0) {
				index += consumed - 1;
				continue;
			}
			if (arg !== "gateway") return false;
			sawGateway = true;
			continue;
		}
		const consumed = consumeGatewayRunOptionToken(args, index);
		if (consumed > 0) {
			index += consumed - 1;
			continue;
		}
		if (!sawRun && arg === "run") {
			sawRun = true;
			continue;
		}
		return false;
	}
	return sawGateway;
}
function hasJsonOutputFlag(argv) {
	return argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
}
async function tryRunGatewayRunFastPath(argv, startupTrace) {
	if (!isGatewayRunFastPathArgv(argv)) return false;
	const [{ Command }, { addGatewayRunCommand }, { VERSION }, { emitCliBanner }, { resolveCliStartupPolicy }] = await startupTrace.measure("gateway-run-imports", () => Promise.all([
		import("commander"),
		import("../run-rWzMre29.js"),
		import("../version-IzKgi5Mn.js"),
		import("../banner-C-IlKmSt.js"),
		import("../command-startup-policy-nhKOY_54.js")
	]));
	if (!resolveCliStartupPolicy({
		commandPath: resolveCliArgvInvocation(argv).commandPath,
		jsonOutputMode: hasJsonOutputFlag(argv),
		routeMode: true
	}).hideBanner) emitCliBanner(VERSION, { argv });
	const program = new Command();
	program.name("openclaw");
	program.enablePositionalOptions();
	program.option("--no-color", "Disable ANSI colors", false);
	program.exitOverride((err) => {
		process$1.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
		throw err;
	});
	addGatewayRunCommand(addGatewayRunCommand(program.command("gateway").description("Run, inspect, and query the WebSocket Gateway")).command("run").description("Run the WebSocket Gateway (foreground)"));
	try {
		await startupTrace.measure("gateway-run-parse", () => program.parseAsync(argv));
	} catch (error) {
		if (!isCommanderParseExit(error)) throw error;
		process$1.exitCode = error.exitCode;
	}
	return true;
}
async function closeCliMemoryManagers() {
	try {
		const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
		if (!hasMemoryRuntime()) return;
		const { closeActiveMemorySearchManagers } = await import("../memory-runtime-4yQbcYOe.js");
		await closeActiveMemorySearchManagers();
	} catch {}
}
function resolveMissingPluginCommandMessage(pluginId, config, options) {
	return resolveMissingPluginCommandMessage$1(pluginId, config, options?.registry ? { registry: options.registry } : void 0);
}
function shouldLoadCliDotEnv(env = process$1.env) {
	if (existsSync(path.join(process$1.cwd(), ".env"))) return true;
	return existsSync(path.join(resolveStateDir(env), ".env"));
}
function isCommanderParseExit(error) {
	if (!error || typeof error !== "object") return false;
	const candidate = error;
	return typeof candidate.exitCode === "number" && Number.isInteger(candidate.exitCode) && typeof candidate.code === "string" && candidate.code.startsWith("commander.");
}
async function ensureCliEnvProxyDispatcher() {
	try {
		const { hasEnvHttpProxyAgentConfigured } = await import("../proxy-env-zI8DbzLn.js");
		if (!hasEnvHttpProxyAgentConfigured()) return;
		const { ensureGlobalUndiciEnvProxyDispatcher } = await import("../undici-global-dispatcher-CCkxP_jF.js");
		ensureGlobalUndiciEnvProxyDispatcher();
	} catch {}
}
function shouldBootstrapCliProxyBeforeFastPath(env = process$1.env) {
	if (isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_ENABLED) || isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_REQUIRE)) return true;
	return CLI_PROXY_ENV_KEYS.some((key) => {
		const value = env[key];
		return typeof value === "string" && value.trim().length > 0;
	});
}
function isKnownBuiltInCommandRoot(primary) {
	return getCoreCliCommandNames().includes(primary) || getSubCliEntries().some((entry) => entry.name === primary);
}
async function isPluginCliRoot(params) {
	try {
		const { resolvePluginCliRootOwnerIds } = await import("../cli-registry-loader-B_wBM4UK.js");
		const ownerIds = await resolvePluginCliRootOwnerIds({
			cfg: params.config,
			env: process$1.env,
			primaryCommand: params.primary
		});
		return ownerIds === null ? null : ownerIds.length > 0;
	} catch {
		return null;
	}
}
async function resolveUnownedCliPrimary(params) {
	const invocation = resolveCliArgvInvocation(rewriteUpdateFlagArgv(params.argv));
	const { primary } = invocation;
	if (invocation.hasHelpOrVersion || !primary || primary === "help" || isReservedNonPluginCommandRoot(primary) || isKnownBuiltInCommandRoot(primary)) return null;
	if (await isPluginCliRoot({
		primary,
		config: params.config
	}) !== false) return null;
	return primary;
}
async function bootstrapCliProxyCaptureAndDispatcher(startupTrace, options = {}) {
	const [{ initializeDebugProxyCapture, finalizeDebugProxyCapture }, { maybeWarnAboutDebugProxyCoverage }] = await startupTrace.measure("proxy-imports", () => Promise.all([import("../runtime-8lnGnAUx.js"), import("../coverage-DkxiERI5.js")]));
	initializeDebugProxyCapture("cli");
	process$1.once("exit", () => {
		finalizeDebugProxyCapture();
	});
	if (options.ensureDispatcher !== false) await startupTrace.measure("proxy-dispatcher", () => ensureCliEnvProxyDispatcher());
	maybeWarnAboutDebugProxyCoverage();
}
async function runCli(argv = process$1.argv) {
	const originalArgv = normalizeWindowsArgv(argv);
	const startupTrace = createGatewayCliMainStartupTrace(originalArgv);
	const parsedContainer = parseCliContainerArgs(originalArgv);
	if (!parsedContainer.ok) throw new Error(parsedContainer.error);
	const parsedProfile = parseCliProfileArgs(parsedContainer.argv);
	if (!parsedProfile.ok) throw new Error(parsedProfile.error);
	if (parsedProfile.profile) applyCliProfileEnv({ profile: parsedProfile.profile });
	if ((parsedContainer.container ?? normalizeOptionalString(process$1.env.OPENCLAW_CONTAINER) ?? null) && parsedProfile.profile) throw new Error("--container cannot be combined with --profile/--dev");
	const containerTarget = maybeRunCliInContainer(originalArgv);
	if (containerTarget.handled) {
		if (containerTarget.exitCode !== 0) process$1.exitCode = containerTarget.exitCode;
		return;
	}
	let normalizedArgv = parsedProfile.argv;
	startupTrace.mark("argv");
	if (shouldLoadCliDotEnv()) await startupTrace.measure("dotenv", async () => {
		const { loadCliDotEnv } = await import("../dotenv-C3nmghxf.js");
		loadCliDotEnv({ quiet: true });
	});
	normalizeEnv();
	if (shouldEnsureCliPath(normalizedArgv)) ensureOpenClawCliOnPath();
	assertSupportedRuntime();
	let proxyHandle = null;
	let bestEffortConfigPromise = null;
	const readBestEffortCliConfig = async () => {
		if (!bestEffortConfigPromise) bestEffortConfigPromise = import("../io-DBkd1Wl5.js").then(({ readBestEffortConfig }) => readBestEffortConfig());
		return await bestEffortConfigPromise;
	};
	const stopStartedProxy = async () => {
		const handle = proxyHandle;
		proxyHandle = null;
		if (handle) {
			const { stopProxy } = await import("../proxy-lifecycle-Dj8VGi1k.js");
			await stopProxy(handle);
		}
	};
	const killStartedProxy = () => {
		const handle = proxyHandle;
		proxyHandle = null;
		handle?.kill("SIGTERM");
	};
	if (shouldStartProxyForCli(normalizedArgv)) {
		const config = await readBestEffortCliConfig();
		const unownedPrimary = await resolveUnownedCliPrimary({
			argv: normalizedArgv,
			config
		});
		if (unownedPrimary) throw new Error(`Unknown command: openclaw ${unownedPrimary}. No built-in command or plugin CLI metadata owns "${unownedPrimary}".`);
		const { startProxy } = await import("../proxy-lifecycle-Dj8VGi1k.js");
		proxyHandle = await startProxy(config?.proxy ?? void 0);
	}
	let onSigterm = null;
	let onSigint = null;
	let onExit = null;
	if (proxyHandle) {
		const shutdown = (exitCode) => {
			if (onSigterm) process$1.off("SIGTERM", onSigterm);
			if (onSigint) process$1.off("SIGINT", onSigint);
			stopStartedProxy().finally(() => {
				process$1.exit(exitCode);
			});
		};
		onSigterm = () => shutdown(143);
		onSigint = () => shutdown(130);
		onExit = () => killStartedProxy();
		process$1.once("SIGTERM", onSigterm);
		process$1.once("SIGINT", onSigint);
		process$1.once("exit", onExit);
	}
	try {
		if (shouldUseRootHelpFastPath(normalizedArgv)) {
			const { outputPrecomputedRootHelpText } = await import("../root-help-metadata-AVPiCEiy.js");
			if (!outputPrecomputedRootHelpText()) {
				const { outputRootHelp } = await import("../root-help-D0tiaOaR.js");
				await outputRootHelp();
			}
			return;
		}
		if (shouldUseBrowserHelpFastPath(normalizedArgv)) {
			const { outputPrecomputedBrowserHelpText } = await import("../root-help-metadata-AVPiCEiy.js");
			if (outputPrecomputedBrowserHelpText()) return;
		}
		const shouldRunBareRootCrestodian = shouldStartCrestodianForBareRoot(normalizedArgv);
		const shouldRunModernOnboardCrestodian = shouldStartCrestodianForModernOnboard(normalizedArgv);
		if (shouldRunBareRootCrestodian || shouldRunModernOnboardCrestodian) await ensureCliEnvProxyDispatcher();
		if (shouldRunBareRootCrestodian) {
			if (!process$1.stdin.isTTY || !process$1.stdout.isTTY) {
				console.error("Crestodian needs an interactive TTY. Use `openclaw crestodian --message \"status\"` for one command.");
				process$1.exitCode = 1;
				return;
			}
			const { runCrestodian } = await import("../crestodian/crestodian.js");
			const { createCliProgress } = await import("../progress-B8NwovNC.js");
			const progress = createCliProgress({
				label: "Starting Crestodian…",
				indeterminate: true,
				delayMs: 0,
				fallback: "none"
			});
			let progressStopped = false;
			const stopProgress = () => {
				if (progressStopped) return;
				progressStopped = true;
				progress.done();
			};
			try {
				await runCrestodian({ onReady: stopProgress });
			} finally {
				stopProgress();
			}
			return;
		}
		if (shouldRunModernOnboardCrestodian) {
			const { runCrestodian } = await import("../crestodian/crestodian.js");
			const nonInteractive = normalizedArgv.includes("--non-interactive");
			await runCrestodian({
				message: nonInteractive ? "overview" : void 0,
				yes: false,
				json: normalizedArgv.includes("--json"),
				interactive: !nonInteractive
			});
			return;
		}
		const shouldUseCliEnvProxy = shouldStartProxyForCli(normalizedArgv);
		const bootstrapProxyBeforeFastPath = shouldUseCliEnvProxy && shouldBootstrapCliProxyBeforeFastPath();
		if (!bootstrapProxyBeforeFastPath && await tryRunGatewayRunFastPath(normalizedArgv, startupTrace)) return;
		await bootstrapCliProxyCaptureAndDispatcher(startupTrace, { ensureDispatcher: shouldUseCliEnvProxy });
		if (bootstrapProxyBeforeFastPath && await tryRunGatewayRunFastPath(normalizedArgv, startupTrace)) return;
		const { tryRouteCli } = await startupTrace.measure("route-import", () => import("../route-QoTiytAN.js"));
		if (await startupTrace.measure("route", () => tryRouteCli(normalizedArgv))) return;
		const { createCliProgress } = await import("../progress-B8NwovNC.js");
		const startupProgress = createCliProgress({
			label: "Loading OpenClaw CLI…",
			indeterminate: true,
			delayMs: 0,
			fallback: "none"
		});
		let startupProgressStopped = false;
		const stopStartupProgress = () => {
			if (startupProgressStopped) return;
			startupProgressStopped = true;
			startupProgress.done();
		};
		try {
			const { enableConsoleCapture } = await import("../logging-3gjivgK8.js");
			enableConsoleCapture();
			const [{ buildProgram }, { formatUncaughtError }, { runFatalErrorHooks }, { installUnhandledRejectionHandler, isBenignUncaughtExceptionError, isUncaughtExceptionHandled }, { restoreTerminalState }] = await startupTrace.measure("core-imports", () => Promise.all([
				import("../program-Cq1ezNqI.js"),
				import("../infra/errors.js"),
				import("../fatal-error-hooks-DxqbkWSf.js"),
				import("../unhandled-rejections-R-ftAgNK.js"),
				import("../restore-qsU-mNJM.js")
			]));
			const program = await startupTrace.measure("build-program", () => buildProgram());
			installUnhandledRejectionHandler();
			process$1.on("uncaughtException", (error) => {
				if (isUncaughtExceptionHandled(error)) return;
				if (isBenignUncaughtExceptionError(error)) {
					console.warn("[openclaw] Non-fatal uncaught exception (continuing):", formatUncaughtError(error));
					return;
				}
				console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
				for (const message of runFatalErrorHooks({
					reason: "uncaught_exception",
					error
				})) console.error("[openclaw]", message);
				restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
				process$1.exit(1);
			});
			const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
			const { primary } = resolveCliArgvInvocation(parseArgv);
			if (primary && shouldRegisterPrimaryCommandOnly(parseArgv)) await startupTrace.measure("register-primary", async () => {
				const { getProgramContext } = await import("../program-context-D2vV0Qae.js");
				const ctx = getProgramContext(program);
				if (ctx) {
					const { registerCoreCliByName } = await import("../command-registry-Dcyf0WY4.js");
					await registerCoreCliByName(program, ctx, primary, parseArgv);
				}
				const { registerSubCliByName } = await import("../register.subclis-BEJzXuE7.js");
				await registerSubCliByName(program, primary, parseArgv);
			});
			if (!shouldSkipPluginCommandRegistration({
				argv: parseArgv,
				primary,
				hasBuiltinPrimary: primary !== null && program.commands.some((command) => command.name() === primary || command.aliases().includes(primary))
			})) {
				const config = await startupTrace.measure("register-plugin-commands", async () => {
					const { registerPluginCliCommandsFromValidatedConfig } = await import("../cli-D8Z7_kom.js");
					return await registerPluginCliCommandsFromValidatedConfig(program, void 0, void 0, {
						mode: "lazy",
						primary
					});
				});
				if (config) {
					if (primary && !program.commands.some((command) => command.name() === primary || command.aliases().includes(primary))) {
						const { resolveManifestCommandAliasOwner } = await import("../manifest-command-aliases.runtime-BtOhJg2F.js");
						const missingPluginCommandMessage = resolveMissingPluginCommandMessage$1(primary, config, { resolveCommandAliasOwner: resolveManifestCommandAliasOwner });
						if (missingPluginCommandMessage) throw new Error(missingPluginCommandMessage);
					}
				}
			}
			stopStartupProgress();
			try {
				await startupTrace.measure("parse", () => program.parseAsync(parseArgv));
			} catch (error) {
				if (!isCommanderParseExit(error)) throw error;
				process$1.exitCode = error.exitCode;
			}
		} finally {
			stopStartupProgress();
		}
	} finally {
		if (onSigterm) process$1.off("SIGTERM", onSigterm);
		if (onSigint) process$1.off("SIGINT", onSigint);
		if (onExit) process$1.off("exit", onExit);
		await stopStartedProxy();
		await closeCliMemoryManagers();
	}
}
function isCliMainModule() {
	return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
//#endregion
export { isCliMainModule, isGatewayRunFastPathArgv, resolveMissingPluginCommandMessage, rewriteUpdateFlagArgv, runCli, shouldEnsureCliPath, shouldStartCrestodianForBareRoot, shouldStartCrestodianForModernOnboard, shouldStartProxyForCli, shouldUseBrowserHelpFastPath, shouldUseRootHelpFastPath };
