import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import { D as getCommandPathWithRootOptions, M as getVerboseFlag, N as hasFlag, P as hasHelpOrVersion, s as setVerbose } from "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import "./theme-UkqnBJaj.js";
import { l as defaultRuntime } from "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import { t as isTruthyEnvValue } from "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-Do8MzKyM.js";
import "./links-Cx-Xmp-Y.js";
import "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import "./registry-DrRO3PZ7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import { n as resolveCliName } from "./cli-name-C9PM6wRj.js";
import "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import { n as VERSION } from "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-CcKf_qr0.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import "./cli-utils-DRykF2zj.js";
import "./channel-plugin-ids-DDJhum8r.js";
import "./plugin-registry-DPMvuo5T.js";
import { n as resolveCliChannelOptions } from "./channel-options-B8KkoCsP.js";
import "./register.subclis-Dky2nOhj.js";
import { i as registerProgramCommands } from "./command-registry-DZxchS89.js";
import { n as setProgramContext } from "./program-context-BZIMrX-V.js";
import "./ports-BNKcL56D.js";
import { t as emitCliBanner } from "./banner-BvJ0G81T.js";
import { t as configureProgramHelp } from "./help-BzPcw1YR.js";
import { Command } from "commander";
//#region src/cli/program/context.ts
function createProgramContext() {
	let cachedChannelOptions;
	const getChannelOptions = () => {
		if (cachedChannelOptions === void 0) {cachedChannelOptions = resolveCliChannelOptions();}
		return cachedChannelOptions;
	};
	return {
		programVersion: VERSION,
		get channelOptions() {
			return getChannelOptions();
		},
		get messageChannelOptions() {
			return getChannelOptions().join("|");
		},
		get agentChannelOptions() {
			return ["last", ...getChannelOptions()].join("|");
		}
	};
}
//#endregion
//#region src/cli/program/preaction.ts
function setProcessTitleForCommand(actionCommand) {
	let current = actionCommand;
	while (current.parent && current.parent.parent) {current = current.parent;}
	const name = current.name();
	const cliName = resolveCliName();
	if (!name || name === cliName) {return;}
	process.title = `${cliName}-${name}`;
}
const PLUGIN_REQUIRED_COMMANDS = new Set([
	"message",
	"channels",
	"directory",
	"agents",
	"configure",
	"status",
	"health"
]);
const CONFIG_GUARD_BYPASS_COMMANDS = new Set([
	"backup",
	"doctor",
	"completion",
	"secrets"
]);
const JSON_PARSE_ONLY_COMMANDS = new Set(["config set"]);
let configGuardModulePromise;
let pluginRegistryModulePromise;
function shouldBypassConfigGuard(commandPath) {
	const [primary, secondary] = commandPath;
	if (!primary) {return false;}
	if (CONFIG_GUARD_BYPASS_COMMANDS.has(primary)) {return true;}
	if (primary === "config" && secondary === "validate") {return true;}
	return false;
}
function loadConfigGuardModule() {
	configGuardModulePromise ??= import("./config-guard-DVDdjrpu.js");
	return configGuardModulePromise;
}
function loadPluginRegistryModule() {
	pluginRegistryModulePromise ??= import("./plugin-registry-CC5xtqyE.js");
	return pluginRegistryModulePromise;
}
function resolvePluginRegistryScope(commandPath) {
	return commandPath[0] === "status" || commandPath[0] === "health" ? "channels" : "all";
}
function shouldLoadPluginsForCommand(commandPath, argv) {
	const [primary, secondary] = commandPath;
	if (!primary || !PLUGIN_REQUIRED_COMMANDS.has(primary)) {return false;}
	if ((primary === "status" || primary === "health") && hasFlag(argv, "--json")) {return false;}
	if (primary === "onboard" || primary === "channels" && secondary === "add") {return false;}
	return true;
}
function getRootCommand(command) {
	let current = command;
	while (current.parent) {current = current.parent;}
	return current;
}
function getCliLogLevel(actionCommand) {
	const root = getRootCommand(actionCommand);
	if (typeof root.getOptionValueSource !== "function") {return;}
	if (root.getOptionValueSource("logLevel") !== "cli") {return;}
	const logLevel = root.opts().logLevel;
	return typeof logLevel === "string" ? logLevel : void 0;
}
function isJsonOutputMode(commandPath, argv) {
	if (!hasFlag(argv, "--json")) {return false;}
	const key = `${commandPath[0] ?? ""} ${commandPath[1] ?? ""}`.trim();
	if (JSON_PARSE_ONLY_COMMANDS.has(key)) {return false;}
	return true;
}
function registerPreActionHooks(program, programVersion) {
	program.hook("preAction", async (_thisCommand, actionCommand) => {
		setProcessTitleForCommand(actionCommand);
		const argv = process.argv;
		if (hasHelpOrVersion(argv)) {return;}
		const commandPath = getCommandPathWithRootOptions(argv, 2);
		if (!(isTruthyEnvValue(process.env.OPENCLAW_HIDE_BANNER) || commandPath[0] === "update" || commandPath[0] === "completion" || commandPath[0] === "plugins" && commandPath[1] === "update")) {emitCliBanner(programVersion);}
		const verbose = getVerboseFlag(argv, { includeDebug: true });
		setVerbose(verbose);
		const cliLogLevel = getCliLogLevel(actionCommand);
		if (cliLogLevel) {process.env.OPENCLAW_LOG_LEVEL = cliLogLevel;}
		if (!verbose) {process.env.NODE_NO_WARNINGS ??= "1";}
		if (shouldBypassConfigGuard(commandPath)) {return;}
		const suppressDoctorStdout = isJsonOutputMode(commandPath, argv);
		const { ensureConfigReady } = await loadConfigGuardModule();
		await ensureConfigReady({
			runtime: defaultRuntime,
			commandPath,
			...suppressDoctorStdout ? { suppressDoctorStdout: true } : {}
		});
		if (shouldLoadPluginsForCommand(commandPath, argv)) {
			const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
			ensurePluginRegistryLoaded({ scope: resolvePluginRegistryScope(commandPath) });
		}
	});
}
//#endregion
//#region src/cli/program/build-program.ts
function buildProgram() {
	const program = new Command();
	const ctx = createProgramContext();
	const argv = process.argv;
	setProgramContext(program, ctx);
	configureProgramHelp(program, ctx);
	registerPreActionHooks(program, ctx.programVersion);
	registerProgramCommands(program, ctx, argv);
	return program;
}
//#endregion
export { buildProgram };
