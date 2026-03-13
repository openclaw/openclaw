import { G as getCommandPositionalsWithRootOptions, J as getPrimaryCommand, K as getFlagValue, W as getCommandPathWithRootOptions, X as hasFlag, Y as getVerboseFlag, Z as hasHelpOrVersion, p as defaultRuntime, q as getPositiveIntFlagValue, r as enableConsoleCapture, rt as isValueToken } from "./subsystem-DVwhOlEq.js";
import "./paths-BfR2LXbA.js";
import "./boolean-BHdNsbzF.js";
import { c as applyCliProfileEnv, i as isTruthyEnvValue, l as parseCliProfileArgs, o as normalizeEnv, s as normalizeWindowsArgv } from "./entry.js";
import { Dg as installUnhandledRejectionHandler, R_ as loadDotEnv } from "./auth-profiles-CAw5gP6f.js";
import "./agent-scope-DBEC2O3x.js";
import "./utils-8QNki08A.js";
import "./boundary-file-read-CcBHg_z-.js";
import "./logger-CDI_b4HB.js";
import "./exec-CHkvLtoM.js";
import "./github-copilot-token-CcBrBN3h.js";
import "./registry-B23eaqdH.js";
import "./skills-D75zdym7.js";
import "./frontmatter-BsxcWDrh.js";
import "./env-overrides-DWoj3eoQ.js";
import { t as VERSION } from "./version-N--ZkDj4.js";
import "./search-manager-B1FsI6Ow.js";
import "./plugins-BKDaOrHv.js";
import "./query-expansion-kdDusy7Q.js";
import "./redact-D9pXgQ9w.js";
import { s as formatUncaughtError } from "./cli-utils-Cikq4_a8.js";
import "./fetch-ZNxqGXAR.js";
import "./path-alias-guards-Bq601o2U.js";
import "./delivery-queue-O9EZYTUe.js";
import "./paths-QMxjnO9x.js";
import "./session-cost-usage-6HYiRnfr.js";
import "./prompt-style-2BF77KhS.js";
import "./links-BpBLDDXV.js";
import { t as ensureOpenClawCliOnPath } from "./path-env-0_ia-SUX.js";
import "./note-8rWqI7pr.js";
import "./issue-format-jHeRIpoa.js";
import { t as ensurePluginRegistryLoaded } from "./plugin-registry-Ds475D9o.js";
import { t as assertSupportedRuntime } from "./runtime-guard-CPrdsppg.js";
import { t as emitCliBanner } from "./banner-DvPM0jpQ.js";
import "./doctor-config-flow-CpMysOSY.js";
import { n as ensureConfigReady } from "./config-guard-BmfSWk0H.js";
import process$1 from "node:process";
import "node:url";
//#region src/cli/program/routes.ts
const routeHealth = {
	match: (path) => path[0] === "health",
	loadPlugins: (argv) => !hasFlag(argv, "--json"),
	run: async (argv) => {
		const json = hasFlag(argv, "--json");
		const verbose = getVerboseFlag(argv, { includeDebug: true });
		const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
		if (timeoutMs === null) return false;
		const { healthCommand } = await import("./health-Dpej8X2i.js").then((n) => n.i);
		await healthCommand({
			json,
			timeoutMs,
			verbose
		}, defaultRuntime);
		return true;
	}
};
const routeStatus = {
	match: (path) => path[0] === "status",
	loadPlugins: true,
	run: async (argv) => {
		const json = hasFlag(argv, "--json");
		const deep = hasFlag(argv, "--deep");
		const all = hasFlag(argv, "--all");
		const usage = hasFlag(argv, "--usage");
		const verbose = getVerboseFlag(argv, { includeDebug: true });
		const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
		if (timeoutMs === null) return false;
		const { statusCommand } = await import("./status-BcyrXiU7.js").then((n) => n.t);
		await statusCommand({
			json,
			deep,
			all,
			usage,
			timeoutMs,
			verbose
		}, defaultRuntime);
		return true;
	}
};
const routeSessions = {
	match: (path) => path[0] === "sessions" && !path[1],
	run: async (argv) => {
		const json = hasFlag(argv, "--json");
		const allAgents = hasFlag(argv, "--all-agents");
		const agent = getFlagValue(argv, "--agent");
		if (agent === null) return false;
		const store = getFlagValue(argv, "--store");
		if (store === null) return false;
		const active = getFlagValue(argv, "--active");
		if (active === null) return false;
		const { sessionsCommand } = await import("./sessions-Mnm7nOXU.js");
		await sessionsCommand({
			json,
			store,
			agent,
			allAgents,
			active
		}, defaultRuntime);
		return true;
	}
};
const routeAgentsList = {
	match: (path) => path[0] === "agents" && path[1] === "list",
	run: async (argv) => {
		const json = hasFlag(argv, "--json");
		const bindings = hasFlag(argv, "--bindings");
		const { agentsListCommand } = await import("./agents-BN_0N5yM.js");
		await agentsListCommand({
			json,
			bindings
		}, defaultRuntime);
		return true;
	}
};
const routeMemoryStatus = {
	match: (path) => path[0] === "memory" && path[1] === "status",
	run: async (argv) => {
		const agent = getFlagValue(argv, "--agent");
		if (agent === null) return false;
		const json = hasFlag(argv, "--json");
		const deep = hasFlag(argv, "--deep");
		const index = hasFlag(argv, "--index");
		const verbose = hasFlag(argv, "--verbose");
		const { runMemoryStatus } = await import("./auth-profiles-CAw5gP6f.js").then((n) => n.V);
		await runMemoryStatus({
			agent,
			json,
			deep,
			index,
			verbose
		});
		return true;
	}
};
function getFlagValues(argv, name) {
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
const routes = [
	routeHealth,
	routeStatus,
	routeSessions,
	routeAgentsList,
	routeMemoryStatus,
	{
		match: (path) => path[0] === "config" && path[1] === "get",
		run: async (argv) => {
			const positionals = getCommandPositionalsWithRootOptions(argv, {
				commandPath: ["config", "get"],
				booleanFlags: ["--json"]
			});
			if (!positionals || positionals.length !== 1) return false;
			const pathArg = positionals[0];
			if (!pathArg) return false;
			const json = hasFlag(argv, "--json");
			const { runConfigGet } = await import("./config-cli-B_Lmf63x.js");
			await runConfigGet({
				path: pathArg,
				json
			});
			return true;
		}
	},
	{
		match: (path) => path[0] === "config" && path[1] === "unset",
		run: async (argv) => {
			const positionals = getCommandPositionalsWithRootOptions(argv, { commandPath: ["config", "unset"] });
			if (!positionals || positionals.length !== 1) return false;
			const pathArg = positionals[0];
			if (!pathArg) return false;
			const { runConfigUnset } = await import("./config-cli-B_Lmf63x.js");
			await runConfigUnset({ path: pathArg });
			return true;
		}
	},
	{
		match: (path) => path[0] === "models" && path[1] === "list",
		run: async (argv) => {
			const provider = getFlagValue(argv, "--provider");
			if (provider === null) return false;
			const all = hasFlag(argv, "--all");
			const local = hasFlag(argv, "--local");
			const json = hasFlag(argv, "--json");
			const plain = hasFlag(argv, "--plain");
			const { modelsListCommand } = await import("./models-DPSX2VI_.js");
			await modelsListCommand({
				all,
				local,
				provider,
				json,
				plain
			}, defaultRuntime);
			return true;
		}
	},
	{
		match: (path) => path[0] === "models" && path[1] === "status",
		run: async (argv) => {
			const probeProvider = getFlagValue(argv, "--probe-provider");
			if (probeProvider === null) return false;
			const probeTimeout = getFlagValue(argv, "--probe-timeout");
			if (probeTimeout === null) return false;
			const probeConcurrency = getFlagValue(argv, "--probe-concurrency");
			if (probeConcurrency === null) return false;
			const probeMaxTokens = getFlagValue(argv, "--probe-max-tokens");
			if (probeMaxTokens === null) return false;
			const agent = getFlagValue(argv, "--agent");
			if (agent === null) return false;
			const probeProfileValues = getFlagValues(argv, "--probe-profile");
			if (probeProfileValues === null) return false;
			const probeProfile = probeProfileValues.length === 0 ? void 0 : probeProfileValues.length === 1 ? probeProfileValues[0] : probeProfileValues;
			const json = hasFlag(argv, "--json");
			const plain = hasFlag(argv, "--plain");
			const check = hasFlag(argv, "--check");
			const probe = hasFlag(argv, "--probe");
			const { modelsStatusCommand } = await import("./models-DPSX2VI_.js");
			await modelsStatusCommand({
				json,
				plain,
				check,
				probe,
				probeProvider,
				probeProfile,
				probeTimeout,
				probeConcurrency,
				probeMaxTokens,
				agent
			}, defaultRuntime);
			return true;
		}
	}
];
function findRoutedCommand(path) {
	for (const route of routes) if (route.match(path)) return route;
	return null;
}
//#endregion
//#region src/cli/route.ts
async function prepareRoutedCommand(params) {
	const suppressDoctorStdout = hasFlag(params.argv, "--json");
	emitCliBanner(VERSION, { argv: params.argv });
	await ensureConfigReady({
		runtime: defaultRuntime,
		commandPath: params.commandPath,
		...suppressDoctorStdout ? { suppressDoctorStdout: true } : {}
	});
	if (typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins) ensurePluginRegistryLoaded();
}
async function tryRouteCli(argv) {
	if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) return false;
	if (hasHelpOrVersion(argv)) return false;
	const path = getCommandPathWithRootOptions(argv, 2);
	if (!path[0]) return false;
	const route = findRoutedCommand(path);
	if (!route) return false;
	await prepareRoutedCommand({
		argv,
		commandPath: path,
		loadPlugins: route.loadPlugins
	});
	return route.run(argv);
}
//#endregion
//#region src/cli/run-main.ts
async function closeCliMemoryManagers() {
	try {
		const { closeAllMemorySearchManagers } = await import("./search-manager-B1FsI6Ow.js").then((n) => n.n);
		await closeAllMemorySearchManagers();
	} catch {}
}
function rewriteUpdateFlagArgv(argv) {
	const index = argv.indexOf("--update");
	if (index === -1) return argv;
	const next = [...argv];
	next.splice(index, 1, "update");
	return next;
}
function shouldSkipPluginCommandRegistration(params) {
	if (params.hasBuiltinPrimary) return true;
	if (!params.primary) return hasHelpOrVersion(params.argv);
	return false;
}
function shouldEnsureCliPath(argv) {
	if (hasHelpOrVersion(argv)) return false;
	const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
	if (!primary) return true;
	if (primary === "status" || primary === "health" || primary === "sessions") return false;
	if (primary === "config" && (secondary === "get" || secondary === "unset")) return false;
	if (primary === "models" && (secondary === "list" || secondary === "status")) return false;
	return true;
}
async function runCli(argv = process$1.argv) {
	let normalizedArgv = normalizeWindowsArgv(argv);
	const parsedProfile = parseCliProfileArgs(normalizedArgv);
	if (!parsedProfile.ok) throw new Error(parsedProfile.error);
	if (parsedProfile.profile) applyCliProfileEnv({ profile: parsedProfile.profile });
	normalizedArgv = parsedProfile.argv;
	loadDotEnv({ quiet: true });
	normalizeEnv();
	if (shouldEnsureCliPath(normalizedArgv)) ensureOpenClawCliOnPath();
	assertSupportedRuntime();
	try {
		if (await tryRouteCli(normalizedArgv)) return;
		enableConsoleCapture();
		const { buildProgram } = await import("./program-Ca7Q8VFZ.js");
		const program = buildProgram();
		installUnhandledRejectionHandler();
		process$1.on("uncaughtException", (error) => {
			console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
			process$1.exit(1);
		});
		const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
		const primary = getPrimaryCommand(parseArgv);
		if (primary) {
			const { getProgramContext } = await import("./program-context-BqhaZ9lS.js").then((n) => n.n);
			const ctx = getProgramContext(program);
			if (ctx) {
				const { registerCoreCliByName } = await import("./command-registry-D2x3fIDF.js").then((n) => n.t);
				await registerCoreCliByName(program, ctx, primary, parseArgv);
			}
			const { registerSubCliByName } = await import("./register.subclis-9eoG0Tk8.js").then((n) => n.a);
			await registerSubCliByName(program, primary);
		}
		if (!shouldSkipPluginCommandRegistration({
			argv: parseArgv,
			primary,
			hasBuiltinPrimary: primary !== null && program.commands.some((command) => command.name() === primary)
		})) {
			const { registerPluginCliCommands } = await import("./cli-B5q2i4uh.js");
			const { loadValidatedConfigForPluginRegistration } = await import("./register.subclis-9eoG0Tk8.js").then((n) => n.a);
			const config = await loadValidatedConfigForPluginRegistration();
			if (config) registerPluginCliCommands(program, config);
		}
		await program.parseAsync(parseArgv);
	} finally {
		await closeCliMemoryManagers();
	}
}
//#endregion
export { runCli };
