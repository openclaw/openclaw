import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { D as isValueToken, a as getPositiveIntFlagValue, c as hasFlag, i as getFlagValue, r as getCommandPositionalsWithRootOptions, s as getVerboseFlag } from "./argv-j42r4Rb7.js";
import { t as resolveCliArgvInvocation } from "./argv-invocation-C7Tq1otP.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { i as cliCommandCatalog, r as matchesCommandPath, t as resolveCliCommandPathPolicy } from "./command-path-policy-Dc5x3coi.js";
import { n as ensureCliExecutionBootstrap, r as resolveCliExecutionStartupContext, t as applyCliExecutionStartupPresentation } from "./command-execution-startup-Wa51j0o_.js";
//#region src/cli/program/route-args.ts
function parseOptionalFlagValue(argv, name) {
	const value = getFlagValue(argv, name);
	if (value === null) return { ok: false };
	return {
		ok: true,
		value
	};
}
function parseRepeatedFlagValues(argv, name) {
	const values = [];
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg || arg === "--") break;
		if (arg === name) {
			const next = args[i + 1];
			if (!isValueToken(next)) return null;
			values.push(next);
			i += 1;
			continue;
		}
		if (arg.startsWith(`${name}=`)) {
			const value = arg.slice(name.length + 1).trim();
			if (!value) return null;
			values.push(value);
		}
	}
	return values;
}
function parseSinglePositional(argv, params) {
	const positionals = getCommandPositionalsWithRootOptions(argv, params);
	if (!positionals || positionals.length !== 1) return null;
	return positionals[0] ?? null;
}
function parseHealthRouteArgs(argv) {
	const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
	if (timeoutMs === null) return null;
	return {
		json: hasFlag(argv, "--json"),
		verbose: getVerboseFlag(argv, { includeDebug: true }),
		timeoutMs
	};
}
function parseStatusRouteArgs(argv) {
	const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
	if (timeoutMs === null) return null;
	return {
		json: hasFlag(argv, "--json"),
		deep: hasFlag(argv, "--deep"),
		all: hasFlag(argv, "--all"),
		usage: hasFlag(argv, "--usage"),
		verbose: getVerboseFlag(argv, { includeDebug: true }),
		timeoutMs
	};
}
function parseGatewayStatusRouteArgs(argv) {
	const url = parseOptionalFlagValue(argv, "--url");
	if (!url.ok) return null;
	const token = parseOptionalFlagValue(argv, "--token");
	if (!token.ok) return null;
	const password = parseOptionalFlagValue(argv, "--password");
	if (!password.ok) return null;
	const timeout = parseOptionalFlagValue(argv, "--timeout");
	if (!timeout.ok) return null;
	const ssh = parseOptionalFlagValue(argv, "--ssh");
	if (!ssh.ok || ssh.value !== void 0) return null;
	const sshIdentity = parseOptionalFlagValue(argv, "--ssh-identity");
	if (!sshIdentity.ok || sshIdentity.value !== void 0) return null;
	if (hasFlag(argv, "--ssh-auto")) return null;
	return {
		rpc: {
			url: url.value,
			token: token.value,
			password: password.value,
			timeout: timeout.value
		},
		deep: hasFlag(argv, "--deep"),
		json: hasFlag(argv, "--json"),
		requireRpc: hasFlag(argv, "--require-rpc"),
		probe: !hasFlag(argv, "--no-probe")
	};
}
function parseSessionsRouteArgs(argv) {
	const agent = parseOptionalFlagValue(argv, "--agent");
	if (!agent.ok) return null;
	const store = parseOptionalFlagValue(argv, "--store");
	if (!store.ok) return null;
	const active = parseOptionalFlagValue(argv, "--active");
	if (!active.ok) return null;
	const limit = parseOptionalFlagValue(argv, "--limit");
	if (!limit.ok) return null;
	return {
		json: hasFlag(argv, "--json"),
		allAgents: hasFlag(argv, "--all-agents"),
		agent: agent.value,
		store: store.value,
		active: active.value,
		limit: limit.value
	};
}
function parseAgentsListRouteArgs(argv) {
	return {
		json: hasFlag(argv, "--json"),
		bindings: hasFlag(argv, "--bindings")
	};
}
function parseConfigGetRouteArgs(argv) {
	const path = parseSinglePositional(argv, {
		commandPath: ["config", "get"],
		booleanFlags: ["--json"]
	});
	if (!path) return null;
	return {
		path,
		json: hasFlag(argv, "--json")
	};
}
function parseConfigUnsetRouteArgs(argv) {
	const path = parseSinglePositional(argv, {
		commandPath: ["config", "unset"],
		booleanFlags: [
			"--dry-run",
			"--allow-exec",
			"--json"
		]
	});
	if (!path) return null;
	return {
		path,
		cliOptions: {
			dryRun: hasFlag(argv, "--dry-run"),
			allowExec: hasFlag(argv, "--allow-exec"),
			json: hasFlag(argv, "--json")
		}
	};
}
function parseModelsListRouteArgs(argv) {
	const provider = parseOptionalFlagValue(argv, "--provider");
	if (!provider.ok) return null;
	return {
		provider: provider.value,
		all: hasFlag(argv, "--all"),
		local: hasFlag(argv, "--local"),
		json: hasFlag(argv, "--json"),
		plain: hasFlag(argv, "--plain")
	};
}
function parseModelsStatusRouteArgs(argv) {
	const probeProvider = parseOptionalFlagValue(argv, "--probe-provider");
	if (!probeProvider.ok) return null;
	const probeTimeout = parseOptionalFlagValue(argv, "--probe-timeout");
	if (!probeTimeout.ok) return null;
	const probeConcurrency = parseOptionalFlagValue(argv, "--probe-concurrency");
	if (!probeConcurrency.ok) return null;
	const probeMaxTokens = parseOptionalFlagValue(argv, "--probe-max-tokens");
	if (!probeMaxTokens.ok) return null;
	const agent = parseOptionalFlagValue(argv, "--agent");
	if (!agent.ok) return null;
	const probeProfileValues = parseRepeatedFlagValues(argv, "--probe-profile");
	if (probeProfileValues === null) return null;
	const probeProfile = probeProfileValues.length === 0 ? void 0 : probeProfileValues.length === 1 ? probeProfileValues[0] : probeProfileValues;
	return {
		probeProvider: probeProvider.value,
		probeTimeout: probeTimeout.value,
		probeConcurrency: probeConcurrency.value,
		probeMaxTokens: probeMaxTokens.value,
		agent: agent.value,
		probeProfile,
		json: hasFlag(argv, "--json"),
		plain: hasFlag(argv, "--plain"),
		check: hasFlag(argv, "--check"),
		probe: hasFlag(argv, "--probe")
	};
}
function parseChannelsListRouteArgs(argv) {
	return {
		json: hasFlag(argv, "--json"),
		all: hasFlag(argv, "--all")
	};
}
function parseChannelsStatusRouteArgs(argv) {
	const timeout = parseOptionalFlagValue(argv, "--timeout");
	const channel = parseOptionalFlagValue(argv, "--channel");
	if (!timeout.ok) return null;
	if (!channel.ok) return null;
	return {
		channel: channel.value,
		json: hasFlag(argv, "--json"),
		probe: hasFlag(argv, "--probe"),
		timeout: timeout.value
	};
}
function parsePluginsListRouteArgs(argv) {
	if (!hasFlag(argv, "--json")) return null;
	const positionals = getCommandPositionalsWithRootOptions(argv, {
		commandPath: ["plugins", "list"],
		booleanFlags: [
			"--json",
			"--enabled",
			"--verbose"
		]
	});
	if (!positionals || positionals.length !== 0) return null;
	return {
		json: true,
		enabled: hasFlag(argv, "--enabled"),
		verbose: hasFlag(argv, "--verbose")
	};
}
function parseTasksListRouteArgsForCommandPath(argv, commandPath) {
	if (!hasFlag(argv, "--json")) return null;
	const positionals = getCommandPositionalsWithRootOptions(argv, {
		commandPath,
		booleanFlags: ["--json"],
		valueFlags: ["--runtime", "--status"]
	});
	if (!positionals || positionals.length !== 0) return null;
	const runtime = parseOptionalFlagValue(argv, "--runtime");
	if (!runtime.ok) return null;
	const status = parseOptionalFlagValue(argv, "--status");
	if (!status.ok) return null;
	return {
		json: true,
		runtime: runtime.value,
		status: status.value
	};
}
function parseTasksListRouteArgs(argv) {
	return parseTasksListRouteArgsForCommandPath(argv, ["tasks"]) ?? parseTasksListRouteArgsForCommandPath(argv, ["tasks", "list"]);
}
function parseTasksAuditRouteArgs(argv) {
	if (!hasFlag(argv, "--json")) return null;
	const positionals = getCommandPositionalsWithRootOptions(argv, {
		commandPath: ["tasks", "audit"],
		booleanFlags: ["--json"],
		valueFlags: [
			"--severity",
			"--code",
			"--limit"
		]
	});
	if (!positionals || positionals.length !== 0) return null;
	const severity = parseOptionalFlagValue(argv, "--severity");
	if (!severity.ok) return null;
	const code = parseOptionalFlagValue(argv, "--code");
	if (!code.ok) return null;
	const limit = getPositiveIntFlagValue(argv, "--limit");
	if (limit === null) return null;
	return {
		json: true,
		severity: severity.value,
		code: code.value,
		limit
	};
}
//#endregion
//#region src/cli/program/routed-command-definitions.ts
function defineRoutedCommand(definition) {
	return definition;
}
const configCliLoader = createLazyImportLoader(() => import("./config-cli-6z89Zcrf.js"));
const agentsListCommandLoader = createLazyImportLoader(() => import("./agents.commands.list-DrQOg5mT.js"));
const modelsListCommandLoader = createLazyImportLoader(() => import("./list.list-command-DfYZhoB7.js"));
const modelsStatusCommandLoader = createLazyImportLoader(() => import("./list.status-command-BB3B-E90.js"));
function loadConfigCli() {
	return configCliLoader.load();
}
function loadAgentsListCommand() {
	return agentsListCommandLoader.load();
}
function loadModelsListCommand() {
	return modelsListCommandLoader.load();
}
function loadModelsStatusCommand() {
	return modelsStatusCommandLoader.load();
}
const routedCommandDefinitions = {
	health: defineRoutedCommand({
		parseArgs: parseHealthRouteArgs,
		runParsedArgs: async (args) => {
			const { healthCommand } = await import("./health-Ihdx28c0.js");
			await healthCommand(args, defaultRuntime);
		}
	}),
	status: defineRoutedCommand({
		parseArgs: parseStatusRouteArgs,
		runParsedArgs: async (args) => {
			if (args.json) {
				const { statusJsonCommand } = await import("./status-json-BuDTle-I.js");
				await statusJsonCommand({
					deep: args.deep,
					all: args.all,
					usage: args.usage,
					timeoutMs: args.timeoutMs
				}, defaultRuntime);
				return;
			}
			const { statusCommand } = await import("./status-DfjmWWDa.js");
			await statusCommand(args, defaultRuntime);
		}
	}),
	"gateway-status": defineRoutedCommand({
		parseArgs: parseGatewayStatusRouteArgs,
		runParsedArgs: async (args) => {
			const { runDaemonStatus } = await import("./status-DF8ViNOp.js");
			await runDaemonStatus(args);
		}
	}),
	sessions: defineRoutedCommand({
		parseArgs: parseSessionsRouteArgs,
		runParsedArgs: async (args) => {
			const { sessionsCommand } = await import("./sessions-JWyVYcWE.js");
			await sessionsCommand(args, defaultRuntime);
		}
	}),
	"agents-list": defineRoutedCommand({
		parseArgs: parseAgentsListRouteArgs,
		runParsedArgs: async (args) => {
			const { agentsListCommand } = await loadAgentsListCommand();
			await agentsListCommand(args, defaultRuntime);
		}
	}),
	"config-get": defineRoutedCommand({
		parseArgs: parseConfigGetRouteArgs,
		runParsedArgs: async (args) => {
			const { runConfigGet } = await loadConfigCli();
			await runConfigGet(args);
		}
	}),
	"config-unset": defineRoutedCommand({
		parseArgs: parseConfigUnsetRouteArgs,
		runParsedArgs: async (args) => {
			const { runConfigUnset } = await loadConfigCli();
			await runConfigUnset(args);
		}
	}),
	"models-list": defineRoutedCommand({
		parseArgs: parseModelsListRouteArgs,
		runParsedArgs: async (args) => {
			const { modelsListCommand } = await loadModelsListCommand();
			await modelsListCommand(args, defaultRuntime);
		}
	}),
	"models-status": defineRoutedCommand({
		parseArgs: parseModelsStatusRouteArgs,
		runParsedArgs: async (args) => {
			const { modelsStatusCommand } = await loadModelsStatusCommand();
			await modelsStatusCommand(args, defaultRuntime);
		}
	}),
	"tasks-list": defineRoutedCommand({
		parseArgs: parseTasksListRouteArgs,
		runParsedArgs: async (args) => {
			const { tasksListJsonCommand } = await import("./tasks-json-83oDNwOv.js");
			await tasksListJsonCommand(args, defaultRuntime);
		}
	}),
	"tasks-audit": defineRoutedCommand({
		parseArgs: parseTasksAuditRouteArgs,
		runParsedArgs: async (args) => {
			const { tasksAuditJsonCommand } = await import("./tasks-json-83oDNwOv.js");
			await tasksAuditJsonCommand(args, defaultRuntime);
		}
	}),
	"channels-list": defineRoutedCommand({
		parseArgs: parseChannelsListRouteArgs,
		runParsedArgs: async (args) => {
			const { channelsListCommand } = await import("./list-nsM-_UW5.js");
			await channelsListCommand(args, defaultRuntime);
		}
	}),
	"channels-status": defineRoutedCommand({
		parseArgs: parseChannelsStatusRouteArgs,
		runParsedArgs: async (args) => {
			const { channelsStatusCommand } = await import("./status-B9IhlBeZ.js");
			await channelsStatusCommand(args, defaultRuntime);
		}
	}),
	"plugins-list": defineRoutedCommand({
		parseArgs: parsePluginsListRouteArgs,
		runParsedArgs: async (args) => {
			const { runPluginsListCommand } = await import("./plugins-list-command-DEJzW0rV.js");
			await runPluginsListCommand(args, defaultRuntime);
		}
	})
};
//#endregion
//#region src/cli/program/route-specs.ts
function createCommandLoadPlugins(commandPath) {
	return (argv) => {
		const loadPlugins = resolveCliCommandPathPolicy([...commandPath]).loadPlugins;
		return loadPlugins === "always" || loadPlugins === "text-only" && !hasFlag(argv, "--json");
	};
}
function createParsedRoute(params) {
	return {
		matches: (path) => matchesCommandPath(path, params.entry.commandPath, { exact: params.entry.exact }),
		canRun: (argv) => Boolean(params.definition.parseArgs(argv)),
		loadPlugins: params.entry.route?.preloadPlugins ? createCommandLoadPlugins(params.entry.commandPath) : void 0,
		run: async (argv) => {
			const args = params.definition.parseArgs(argv);
			if (!args) return false;
			await params.definition.runParsedArgs(args);
			return true;
		}
	};
}
const routedCommands = cliCommandCatalog.filter((entry) => Boolean(entry.route)).map((entry) => createParsedRoute({
	entry,
	definition: routedCommandDefinitions[entry.route.id]
}));
//#endregion
//#region src/cli/program/routes.ts
function findRoutedCommand(path, argv) {
	for (const route of routedCommands) if (route.matches(path)) {
		if (argv && route.canRun && !route.canRun(argv)) continue;
		return route;
	}
	return null;
}
//#endregion
//#region src/cli/route.ts
async function prepareRoutedCommand(params) {
	const { startupPolicy } = resolveCliExecutionStartupContext({
		argv: params.argv,
		jsonOutputMode: hasFlag(params.argv, "--json"),
		env: process.env,
		routeMode: true
	});
	const { VERSION } = await import("./version-DADH-5s2.js");
	await applyCliExecutionStartupPresentation({
		argv: params.argv,
		startupPolicy,
		showBanner: process.stdout.isTTY && !startupPolicy.suppressDoctorStdout,
		version: VERSION
	});
	const shouldLoadPlugins = typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins;
	await ensureCliExecutionBootstrap({
		runtime: defaultRuntime,
		commandPath: params.commandPath,
		startupPolicy,
		loadPlugins: shouldLoadPlugins ?? startupPolicy.loadPlugins
	});
}
async function tryRouteCli(argv) {
	if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) return false;
	const invocation = resolveCliArgvInvocation(argv);
	if (invocation.hasHelpOrVersion) return false;
	if (!invocation.commandPath[0]) return false;
	const route = findRoutedCommand(invocation.commandPath, argv);
	if (!route) return false;
	if (route.canRun && !route.canRun(argv)) return false;
	await prepareRoutedCommand({
		argv,
		commandPath: invocation.commandPath,
		loadPlugins: route.loadPlugins
	});
	return route.run(argv);
}
//#endregion
export { tryRouteCli };
