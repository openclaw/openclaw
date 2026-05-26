import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "../string-coerce-DyL154ka.js";
import { i as normalizeEnv, t as isTruthyEnvValue } from "../env-Dhqok4CP.js";
import { E as consumeRootOptionToken, c as hasFlag, g as getSubCliParentDefaultHelpCommands, h as getSubCliEntries, x as getCoreCliParentDefaultHelpCommands, y as getCoreCliCommandNames } from "../argv-j42r4Rb7.js";
import { y as resolveStateDir } from "../paths-Cw7f9XhU.js";
import { t as isMainModule } from "../is-main-DoKHeRG7.js";
import { t as resolveCliArgvInvocation } from "../argv-invocation-C7Tq1otP.js";
import { i as parseCliContainerArgs, n as parseCliProfileArgs, r as maybeRunCliInContainer, t as applyCliProfileEnv } from "../profile-9JBJfDom.js";
import { t as normalizeWindowsArgv } from "../windows-argv-CVkWOV9N.js";
import { n as resolveManifestCommandAliasOwnerInRegistry, r as resolveManifestToolOwnerInRegistry } from "../manifest-command-aliases-BaxKypWl.js";
import { t as assertSupportedRuntime } from "../runtime-guard-DLdnBLFm.js";
import { t as ensureOpenClawCliOnPath } from "../path-env-BY1Xr76b.js";
import { a as shouldSkipPluginCommandRegistration, r as shouldRegisterPrimaryCommandOnly, t as isReservedNonPluginCommandRoot } from "../command-registration-policy-DlYhvFmN.js";
import { a as consumeGatewayFastPathRootOptionToken, n as resolveCliNetworkProxyPolicy, o as consumeGatewayRunOptionToken, t as resolveCliCommandPathPolicy } from "../command-path-policy-Dc5x3coi.js";
import { n as withConsoleLogsRoutedToStderrForJson, t as hasJsonOutputFlag } from "../json-output-mode-23bE_bfg.js";
import process$1 from "node:process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
//#region src/cli/run-main-policy.ts
const ROOT_HELP_ALIASES = new Set(["tools"]);
const SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS = new Set([
	"setup",
	"onboard",
	"configure"
]);
const PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS = new Set([
	"doctor",
	"gateway",
	"models",
	"plugins"
]);
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);
const BARE_PARENT_DEFAULT_HELP_COMMANDS = new Set([...getCoreCliParentDefaultHelpCommands(), ...getSubCliParentDefaultHelpCommands()]);
function hasHelpFlag(argv) {
	return hasFlag(argv, "-h") || hasFlag(argv, "--help");
}
function resolveStrictPrecomputedSubcommandHelpCommand(argv) {
	const args = argv.slice(2);
	let commandName = null;
	let sawHelp = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg || arg === "--") return null;
		if (VERSION_FLAGS.has(arg)) return null;
		if (!commandName) {
			const consumed = consumeRootOptionToken(args, index);
			if (consumed > 0) {
				index += consumed - 1;
				continue;
			}
			if (arg.startsWith("-")) return null;
			if (!PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS.has(arg)) return null;
			commandName = arg;
			continue;
		}
		if (HELP_FLAGS.has(arg)) {
			sawHelp = true;
			continue;
		}
		return null;
	}
	return commandName && sawHelp ? commandName : null;
}
function isBareParentDefaultHelpArgv(argv) {
	const invocation = resolveCliArgvInvocation(argv);
	const [primary, extra] = invocation.commandPath;
	return !invocation.hasHelpOrVersion && primary !== void 0 && extra === void 0 ? BARE_PARENT_DEFAULT_HELP_COMMANDS.has(primary) : false;
}
function rewriteUpdateFlagArgv(argv) {
	const index = argv.indexOf("--update");
	if (index === -1) return argv;
	const next = [...argv];
	next.splice(index, 1, "update");
	return next;
}
function shouldEnsureCliPath(argv) {
	const invocation = resolveCliArgvInvocation(argv);
	if (invocation.hasHelpOrVersion || shouldStartCrestodianForBareRoot(argv) || isBareParentDefaultHelpArgv(argv)) return false;
	return resolveCliCommandPathPolicy(invocation.commandPath).ensureCliPath;
}
function shouldUseRootHelpFastPath(argv, env = process.env) {
	const invocation = resolveCliArgvInvocation(argv);
	return env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH !== "1" && (invocation.isRootHelpInvocation || invocation.commandPath.length === 1 && ROOT_HELP_ALIASES.has(invocation.commandPath[0] ?? "") && invocation.hasHelpOrVersion || invocation.commandPath.length === 1 && invocation.commandPath[0] === "help" && invocation.hasHelpOrVersion);
}
function shouldUseBrowserHelpFastPath(argv, env = process.env) {
	if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") return false;
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.commandPath.length === 1 && invocation.commandPath[0] === "browser" && hasHelpFlag(argv);
}
function shouldUseSecretsHelpFastPath(argv, env = process.env) {
	if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") return false;
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.commandPath.length === 1 && invocation.commandPath[0] === "secrets" && hasHelpFlag(argv);
}
function shouldUseNodesHelpFastPath(argv, env = process.env) {
	if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") return false;
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.commandPath.length === 1 && invocation.commandPath[0] === "nodes" && hasHelpFlag(argv);
}
function shouldUseSetupOnboardConfigureHelpFastPath(argv, env = process.env) {
	if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") return false;
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.commandPath.length === 1 && SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS.has(invocation.commandPath[0] ?? "") && invocation.hasHelpOrVersion;
}
function resolvePrecomputedSubcommandHelpFastPath(argv, env = process.env) {
	if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") return null;
	return resolveStrictPrecomputedSubcommandHelpCommand(argv);
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
	if (isBareParentDefaultHelpArgv(policyArgv)) return false;
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
		if (allow.length > 0 && !allow.includes(parentPluginId)) {
			if (parentPluginId === normalizedPluginId) return `The \`openclaw ${normalizedPluginId}\` command is unavailable because \`plugins.allow\` excludes "${normalizedPluginId}". Add "${normalizedPluginId}" to \`plugins.allow\` if you want that bundled plugin CLI surface.`;
			return `"${normalizedPluginId}" is not a plugin; it is a command provided by the "${parentPluginId}" plugin. Add "${parentPluginId}" to \`plugins.allow\` instead of "${normalizedPluginId}".`;
		}
		if (config?.plugins?.entries?.[parentPluginId]?.enabled === false) return `The \`openclaw ${normalizedPluginId}\` command is unavailable because \`plugins.entries.${parentPluginId}.enabled=false\`. Re-enable that entry if you want the bundled plugin command surface.`;
		if (commandAlias.kind !== "runtime-slash" && commandAlias.enabledByDefault !== true && config?.plugins?.entries?.[parentPluginId]?.enabled !== true) return `The \`openclaw ${normalizedPluginId}\` command is provided by the "${parentPluginId}" plugin, but that bundled plugin is disabled by default. Run \`openclaw plugins enable ${parentPluginId}\` to enable that CLI surface.`;
		if (commandAlias.kind === "runtime-slash") return `"${normalizedPluginId}" is a runtime slash command (/${normalizedPluginId}), not a CLI command. It is provided by the "${parentPluginId}" plugin. ${commandAlias.cliCommand ? `Use \`openclaw ${commandAlias.cliCommand}\` for related CLI operations, or ` : "Use "}\`/${normalizedPluginId}\` in a chat session.`;
	}
	if (isReservedNonPluginCommandRoot(normalizedPluginId)) return null;
	const toolOwner = options?.registry ? resolveManifestToolOwnerInRegistry({
		toolName: normalizedPluginId,
		registry: options.registry
	}) : options?.resolveToolOwner?.({
		toolName: normalizedPluginId,
		config,
		...options?.registry ? { registry: options.registry } : {}
	});
	if (toolOwner) {
		if (config?.plugins?.entries?.[toolOwner.pluginId]?.enabled !== false && (allow.length === 0 || allow.includes(toolOwner.pluginId))) {
			if (toolOwner.availability === "manifest-only") return `"${normalizedPluginId}" may be provided by the "${toolOwner.pluginId}" plugin as an agent tool, not a CLI subcommand. Run \`openclaw --help\` to see available CLI subcommands.`;
			return `"${normalizedPluginId}" is an agent tool available from the "${toolOwner.pluginId}" plugin, not a CLI subcommand. Use it from an agent turn (model tool-use), not the CLI. Run \`openclaw --help\` to see available CLI subcommands.`;
		}
	}
	if (allow.length > 0 && !allow.includes(normalizedPluginId)) {
		if (parentPluginId && allow.includes(parentPluginId)) return null;
		const normalizedCliCommandSurfaceOwner = normalizeOptionalLowercaseString(options?.resolveCliCommandSurfaceOwner ? options.resolveCliCommandSurfaceOwner({
			command: normalizedPluginId,
			config,
			...options?.registry ? { registry: options.registry } : {}
		}) : options?.registry ? resolveManifestCommandAliasOwnerInRegistry({
			command: normalizedPluginId,
			registry: options.registry
		})?.pluginId : void 0);
		if (!normalizedCliCommandSurfaceOwner) return null;
		if (allow.includes(normalizedCliCommandSurfaceOwner)) return null;
		if (normalizedCliCommandSurfaceOwner !== normalizedPluginId) return `"${normalizedPluginId}" is not a plugin; it is a command provided by the "${normalizedCliCommandSurfaceOwner}" plugin. Add "${normalizedCliCommandSurfaceOwner}" to \`plugins.allow\` instead of "${normalizedPluginId}".`;
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
async function tryRunGatewayRunFastPath(argv, startupTrace) {
	if (!isGatewayRunFastPathArgv(argv)) return false;
	const [{ Command }, { addGatewayRunCommand }, { VERSION }, { emitCliBanner }, { resolveCliStartupPolicy }, { enableConsoleCapture }] = await startupTrace.measure("gateway-run-imports", () => Promise.all([
		import("commander"),
		import("../run-command-C_CdKl2E.js"),
		import("../version-DADH-5s2.js"),
		import("../banner-CxFkn4tt.js"),
		import("../command-startup-policy-BAjGWpeM.js"),
		import("../logging-CKRdrKW_.js")
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
	enableConsoleCapture();
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
		const { closeActiveMemorySearchManagers } = await import("../memory-runtime-BQefnzY0.js");
		await closeActiveMemorySearchManagers();
	} catch {}
}
async function disposeCliAgentHarnesses() {
	try {
		const { listAgentHarnessIds, disposeRegisteredAgentHarnesses } = await import("../registry-CIIp2udg.js");
		if (listAgentHarnessIds().length === 0) return;
		await disposeRegisteredAgentHarnesses();
	} catch {}
}
const UNCONFIGURED_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta"]);
function isUnconfiguredConfigSnapshot(snapshot) {
	if (!snapshot.exists) return true;
	if (!snapshot.valid) return false;
	return Object.keys(snapshot.sourceConfig).every((key) => UNCONFIGURED_CONFIG_IGNORED_KEYS.has(key));
}
async function shouldStartOnboardingForFreshInstall(argv) {
	if (!shouldStartCrestodianForBareRoot(argv)) return false;
	const { readConfigFileSnapshot } = await import("../config/config.js");
	return isUnconfiguredConfigSnapshot(await readConfigFileSnapshot());
}
function pauseNonTtyStdinForCliExit() {
	const stdin = process$1.stdin;
	if (stdin.isTTY) return;
	try {
		stdin.pause();
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
		const { hasEnvHttpProxyAgentConfigured } = await import("../proxy-env-B4yhLzkH.js");
		if (!hasEnvHttpProxyAgentConfigured()) return;
		const { ensureGlobalUndiciEnvProxyDispatcher } = await import("../undici-global-dispatcher-BD_3g4dv.js");
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
		const { resolvePluginCliRootOwnerIds } = await import("../cli-registry-loader-D6fIR-ch.js");
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
function createAllowlistAgnosticCliLookupConfig(config) {
	if (!Array.isArray(config.plugins?.allow) || config.plugins.allow.length === 0) return config;
	return {
		...config,
		plugins: {
			...config.plugins,
			allow: []
		}
	};
}
async function resolveCliCommandSurfaceOwner(params) {
	const { resolveManifestCliCommandSurfaceOwner } = await import("../manifest-command-aliases.runtime-b7e5h3eY.js");
	const manifestOwner = resolveManifestCliCommandSurfaceOwner({
		command: params.primary,
		config: params.config,
		env: process$1.env
	});
	if (manifestOwner) return manifestOwner;
	try {
		const { resolvePluginCliRootOwnerIds } = await import("../cli-registry-loader-D6fIR-ch.js");
		return (await resolvePluginCliRootOwnerIds({
			cfg: createAllowlistAgnosticCliLookupConfig(params.config),
			env: process$1.env,
			primaryCommand: params.primary
		}))?.[0];
	} catch {
		return;
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
async function resolveUnownedCliPrimaryMessage(params) {
	const { resolveManifestCommandAliasOwner, resolveManifestToolOwner } = await import("../manifest-command-aliases.runtime-b7e5h3eY.js");
	const cliCommandSurfaceOwner = await resolveCliCommandSurfaceOwner(params);
	return resolveMissingPluginCommandMessage$1(params.primary, params.config, {
		resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
		resolveToolOwner: resolveManifestToolOwner,
		resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner
	}) ?? `Unknown command: openclaw ${params.primary}. No built-in command or plugin CLI metadata owns "${params.primary}".`;
}
async function bootstrapCliProxyCaptureAndDispatcher(startupTrace, options = {}) {
	const [{ initializeDebugProxyCapture, finalizeDebugProxyCapture }, { maybeWarnAboutDebugProxyCoverage }] = await startupTrace.measure("proxy-imports", () => Promise.all([import("../runtime-E8EXVYTM.js"), import("../coverage-C96hP0Yo.js")]));
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
	const isHelpOrVersionInvocation = resolveCliArgvInvocation(normalizedArgv).hasHelpOrVersion;
	startupTrace.mark("argv");
	if (!isHelpOrVersionInvocation && shouldLoadCliDotEnv()) await startupTrace.measure("dotenv", async () => {
		const { loadCliDotEnv } = await import("../dotenv-BsI4rP_k.js");
		loadCliDotEnv({ quiet: true });
	});
	normalizeEnv();
	if (shouldEnsureCliPath(normalizedArgv)) ensureOpenClawCliOnPath();
	assertSupportedRuntime();
	let proxyHandle = null;
	let bestEffortConfigPromise = null;
	const readBestEffortCliConfig = async () => {
		if (!bestEffortConfigPromise) bestEffortConfigPromise = import("../io-Dwi3-bMk.js").then(({ readBestEffortConfig }) => readBestEffortConfig());
		return await bestEffortConfigPromise;
	};
	const stopStartedProxy = async () => {
		const handle = proxyHandle;
		proxyHandle = null;
		if (handle) {
			const { stopProxy } = await import("../proxy-lifecycle-DIZ7hzzR.js");
			await stopProxy(handle);
		}
	};
	const killStartedProxy = () => {
		const handle = proxyHandle;
		proxyHandle = null;
		handle?.kill("SIGTERM");
	};
	if (!isHelpOrVersionInvocation && shouldStartProxyForCli(normalizedArgv)) {
		const config = await readBestEffortCliConfig();
		const unownedPrimary = await resolveUnownedCliPrimary({
			argv: normalizedArgv,
			config
		});
		if (unownedPrimary) throw new Error(await resolveUnownedCliPrimaryMessage({
			primary: unownedPrimary,
			config
		}));
		const { startProxy } = await import("../proxy-lifecycle-DIZ7hzzR.js");
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
			const { loadRootHelpRenderOptionsForConfigSensitivePlugins } = await import("../root-help-live-config-3vxSmcK6.js");
			const liveRootHelpOptions = await loadRootHelpRenderOptionsForConfigSensitivePlugins(process$1.env);
			if (!liveRootHelpOptions) {
				const { outputPrecomputedRootHelpText } = await import("../root-help-metadata-BihbOLGR.js");
				if (outputPrecomputedRootHelpText()) return;
			}
			const { outputRootHelp } = await import("../root-help-CxFRRMAh.js");
			await outputRootHelp(liveRootHelpOptions ?? void 0);
			return;
		}
		if (shouldUseBrowserHelpFastPath(normalizedArgv)) {
			const { outputPrecomputedBrowserHelpText } = await import("../root-help-metadata-BihbOLGR.js");
			if (outputPrecomputedBrowserHelpText()) return;
		}
		if (shouldUseSetupOnboardConfigureHelpFastPath(normalizedArgv)) {
			const { tryOutputSetupOnboardConfigureHelp } = await import("../setup-onboard-configure-help-fast-path-C80wiT1P.js");
			if (await tryOutputSetupOnboardConfigureHelp(normalizedArgv)) return;
		}
		if (shouldUseSecretsHelpFastPath(normalizedArgv)) {
			const { outputPrecomputedSecretsHelpText } = await import("../root-help-metadata-BihbOLGR.js");
			if (outputPrecomputedSecretsHelpText()) return;
		}
		const precomputedSubcommandHelp = resolvePrecomputedSubcommandHelpFastPath(normalizedArgv);
		if (precomputedSubcommandHelp) {
			const { outputPrecomputedSubcommandHelpText } = await import("../root-help-metadata-BihbOLGR.js");
			if (outputPrecomputedSubcommandHelpText(precomputedSubcommandHelp)) return;
		}
		if (shouldUseNodesHelpFastPath(normalizedArgv)) {
			const { loadRootHelpRenderOptionsForConfigSensitivePlugins } = await import("../root-help-live-config-3vxSmcK6.js");
			if (!await loadRootHelpRenderOptionsForConfigSensitivePlugins(process$1.env)) {
				const { outputPrecomputedNodesHelpText } = await import("../root-help-metadata-BihbOLGR.js");
				if (outputPrecomputedNodesHelpText()) return;
			}
		}
		const shouldRunBareRootCrestodian = shouldStartCrestodianForBareRoot(normalizedArgv);
		const shouldRunModernOnboardCrestodian = shouldStartCrestodianForModernOnboard(normalizedArgv);
		if (shouldRunBareRootCrestodian || shouldRunModernOnboardCrestodian) await ensureCliEnvProxyDispatcher();
		if (shouldRunBareRootCrestodian) {
			if (await shouldStartOnboardingForFreshInstall(normalizedArgv)) {
				if (!process$1.stdin.isTTY || !process$1.stdout.isTTY) {
					console.error("Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.");
					process$1.exitCode = 1;
					return;
				}
				const { setupWizardCommand } = await import("../onboard-CePsejdX.js");
				await setupWizardCommand({});
				return;
			}
			if (!process$1.stdin.isTTY || !process$1.stdout.isTTY) {
				console.error("Crestodian needs an interactive TTY. Use `openclaw crestodian --message \"status\"` for one command.");
				process$1.exitCode = 1;
				return;
			}
			const { runCrestodian } = await import("../crestodian/crestodian.js");
			const { createCliProgress } = await import("../progress-DI8gGVuX.js");
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
		const shouldUseCliEnvProxy = !isHelpOrVersionInvocation && shouldStartProxyForCli(normalizedArgv);
		const bootstrapProxyBeforeFastPath = shouldUseCliEnvProxy && shouldBootstrapCliProxyBeforeFastPath();
		if (!bootstrapProxyBeforeFastPath && await tryRunGatewayRunFastPath(normalizedArgv, startupTrace)) return;
		if (!isHelpOrVersionInvocation) await bootstrapCliProxyCaptureAndDispatcher(startupTrace, { ensureDispatcher: shouldUseCliEnvProxy });
		if (bootstrapProxyBeforeFastPath && await tryRunGatewayRunFastPath(normalizedArgv, startupTrace)) return;
		const { tryRouteCli } = await startupTrace.measure("route-import", () => import("../route-BUmtmhVP.js"));
		if (await startupTrace.measure("route", () => tryRouteCli(normalizedArgv))) return;
		const { createCliProgress } = await import("../progress-DI8gGVuX.js");
		const startupProgress = createCliProgress({
			label: "Loading OpenClaw CLI…",
			indeterminate: true,
			delayMs: 0
		});
		let startupProgressStopped = false;
		const stopStartupProgress = () => {
			if (startupProgressStopped) return;
			startupProgressStopped = true;
			startupProgress.done();
		};
		try {
			const { enableConsoleCapture } = await import("../logging-CKRdrKW_.js");
			enableConsoleCapture();
			const [{ buildProgram }, { formatUncaughtError }, { formatCliFailureLines }, { runFatalErrorHooks }, { installUnhandledRejectionHandler, isBenignUncaughtExceptionError, isUncaughtExceptionHandled }, { restoreTerminalState }] = await startupTrace.measure("core-imports", () => Promise.all([
				import("../program-CUNqgr2S.js"),
				import("../infra/errors.js"),
				import("../failure-output-DpvzkRSd.js"),
				import("../fatal-error-hooks-BJYnE1yM.js"),
				import("../unhandled-rejections-Cm-8hORL.js"),
				import("../restore-x0u7-53p.js")
			]));
			const program = await startupTrace.measure("build-program", () => buildProgram());
			installUnhandledRejectionHandler();
			process$1.on("uncaughtException", (error) => {
				if (isUncaughtExceptionHandled(error)) return;
				if (isBenignUncaughtExceptionError(error)) {
					console.warn("[openclaw] Non-fatal uncaught exception (continuing):", formatUncaughtError(error));
					return;
				}
				for (const line of formatCliFailureLines({
					title: "OpenClaw hit an unexpected runtime error.",
					error,
					argv: normalizedArgv
				})) console.error(line);
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
				const { getProgramContext } = await import("../program-context-WiPANL-_.js");
				const ctx = getProgramContext(program);
				if (ctx) {
					const { registerCoreCliByName } = await import("../command-registry-Bb-4juAN.js");
					await registerCoreCliByName(program, ctx, primary, parseArgv);
				}
				const { registerSubCliByName } = await import("../register.subclis-BaWaiq5d.js");
				await registerSubCliByName(program, primary, parseArgv);
			});
			if (!shouldSkipPluginCommandRegistration({
				argv: parseArgv,
				primary,
				hasBuiltinPrimary: primary !== null && program.commands.some((command) => command.name() === primary || command.aliases().includes(primary))
			})) {
				const config = await startupTrace.measure("register-plugin-commands", async () => {
					const { registerPluginCliCommandsFromValidatedConfig } = await import("../cli-BsRJL3n0.js");
					return await withConsoleLogsRoutedToStderrForJson(parseArgv, () => registerPluginCliCommandsFromValidatedConfig(program, void 0, void 0, {
						mode: "lazy",
						primary
					}));
				});
				if (config) {
					if (primary && !program.commands.some((command) => command.name() === primary || command.aliases().includes(primary))) {
						const { resolveManifestCommandAliasOwner, resolveManifestToolOwner } = await import("../manifest-command-aliases.runtime-b7e5h3eY.js");
						const cliCommandSurfaceOwner = await resolveCliCommandSurfaceOwner({
							primary,
							config
						});
						const missingPluginCommandMessage = resolveMissingPluginCommandMessage$1(primary, config, {
							resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
							resolveToolOwner: resolveManifestToolOwner,
							resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner
						});
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
		await disposeCliAgentHarnesses();
		await closeCliMemoryManagers();
		pauseNonTtyStdinForCliExit();
	}
}
function isCliMainModule() {
	return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
//#endregion
export { isCliMainModule, isGatewayRunFastPathArgv, resolveMissingPluginCommandMessage, resolvePrecomputedSubcommandHelpFastPath, rewriteUpdateFlagArgv, runCli, shouldEnsureCliPath, shouldStartCrestodianForBareRoot, shouldStartCrestodianForModernOnboard, shouldStartOnboardingForFreshInstall, shouldStartProxyForCli, shouldUseBrowserHelpFastPath, shouldUseNodesHelpFastPath, shouldUseRootHelpFastPath, shouldUseSecretsHelpFastPath, shouldUseSetupOnboardConfigureHelpFastPath };
