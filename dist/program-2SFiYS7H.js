import { B as hasHelpOrVersion, E as ALLOWED_LOG_LEVELS, N as getCommandPathWithRootOptions, R as getVerboseFlag, V as hasRootVersionAlias, c as setDevMode, h as theme, k as tryParseLogLevel, l as setVerbose, m as isRich, z as hasFlag } from "./globals-DqM7Q4km.js";
import "./paths-BMo6kTge.js";
import { d as defaultRuntime } from "./subsystem-BXiL6bA6.js";
import "./boolean-DtWR5bt3.js";
import { r as isTruthyEnvValue } from "./entry.js";
import "./auth-profiles-B1fxmUx1.js";
import { n as replaceCliName, r as resolveCliName } from "./command-format-CLEQe4bk.js";
import "./agent-scope-BXg6mLAy.js";
import { c as escapeRegExp } from "./utils-xLjEf_5u.js";
import "./openclaw-root-CUjRHZhy.js";
import "./logger-hujp-3PD.js";
import "./exec-BpP6Q4EB.js";
import "./registry-DTmGzx3d.js";
import "./github-copilot-token-CvN6iidT.js";
import "./manifest-registry-YpcF6BWJ.js";
import { t as VERSION } from "./version-cke7D5Ak.js";
import "./runtime-overrides-ChuaKEss.js";
import "./dock-CK-Sk5ak.js";
import "./model-CGh7DugZ.js";
import "./pi-model-discovery-BZkmUpaa.js";
import "./diagnostic-C6rRlh_V.js";
import "./frontmatter-D2o8_Jfu.js";
import "./skills-LzLwUYxz.js";
import "./path-alias-guards--u7-iWd6.js";
import "./message-channel-Uz3-Q9E0.js";
import "./sessions-DMhNgXSz.js";
import "./plugins-D8yPNTgi.js";
import "./accounts-C8pI_u-9.js";
import "./accounts-Cg8cGZPE.js";
import "./logging-CcxUDNcI.js";
import "./accounts-DBl2tRX-.js";
import "./send-CdrER1WR.js";
import "./send-8O1Zgz0K.js";
import "./subagent-registry-CDMg5a-5.js";
import "./paths-DAWfoG1N.js";
import "./chat-envelope-D3RSz140.js";
import "./client-DCYSexfL.js";
import "./call-NWndvBdo.js";
import "./pairing-token-BXrId5bQ.js";
import "./net-B5SHg7yf.js";
import "./tailnet-c-aDu2yD.js";
import "./tokens-CF4YEP7C.js";
import "./with-timeout-Ch4KxWb3.js";
import "./deliver-GiMMb5Aw.js";
import "./image-ops-Col_4Cje.js";
import "./send-dqNSxNEn.js";
import "./pi-embedded-helpers-DW_Mx1OF.js";
import "./sandbox-CKkFP0hZ.js";
import "./tool-catalog-C04U7H3F.js";
import "./chrome-CTaGzzra.js";
import "./tailscale-djvfM56G.js";
import "./auth-DoPoYVpx.js";
import "./server-context-7qSk8ygR.js";
import "./paths-CSIzn_T3.js";
import "./redact-LEFt15z2.js";
import "./errors-8nIQWcYq.js";
import "./fs-safe-DS4hJvDc.js";
import "./proxy-env-CllmEezI.js";
import "./store--dkmRyD9.js";
import "./ports-fzkwfwGz.js";
import "./trash-G16GLJQp.js";
import "./server-middleware-rY9Zpc1G.js";
import "./tool-images-Dpg-bSxD.js";
import "./thinking-btBo_vAx.js";
import "./models-config-C-2ZW1iZ.js";
import "./exec-approvals-allowlist-Dfk51yYf.js";
import "./exec-safe-bin-runtime-policy-UG-zXrHm.js";
import "./model-catalog-0rr7XVYY.js";
import "./fetch-CrA055Ce.js";
import "./audio-transcription-runner-BoME4iHr.js";
import "./fetch-guard-DmS0QApa.js";
import "./image-BL4rYS1W.js";
import "./tool-display-DriahLIA.js";
import "./api-key-rotation-mLXtRZbM.js";
import "./proxy-fetch-CNRhfyJK.js";
import "./ir-D9WzVNkn.js";
import "./render-BvFSFJZW.js";
import "./target-errors--OnwKhHe.js";
import "./commands-BZwK_e0W.js";
import "./commands-registry-GPuR2VjY.js";
import "./fetch-DJ_HuCiB.js";
import "./pairing-store-D4y0oIXt.js";
import "./exec-approvals-CMViyX-0.js";
import "./nodes-screen-DHyjh9xB.js";
import "./system-run-command-BaNeRDcR.js";
import "./session-utils-DG7mdNeT.js";
import "./session-cost-usage-MmzkMjCb.js";
import "./skill-commands-Cck-2sDK.js";
import "./workspace-dirs-4RiHqH19.js";
import "./channel-activity-CjlbcDAY.js";
import "./tables-Di_xgJL3.js";
import "./server-lifecycle-CCcRK9Sf.js";
import "./stagger--7sJQVSl.js";
import "./channel-selection-Q6LDkNTb.js";
import "./plugin-auto-enable-MaJ8wStj.js";
import "./send-3Yl97FRA.js";
import "./outbound-attachment-DsT9hQwY.js";
import "./delivery-queue-D9iUrwC9.js";
import "./send-DiPxn0Q1.js";
import "./pi-tools.policy-CcDUyobo.js";
import "./proxy-BW96DoS7.js";
import "./runtime-config-collectors-C448f2WD.js";
import "./command-secret-targets-BR6DP2Oq.js";
import "./onboard-helpers-ZCuxYRVy.js";
import "./prompt-style-DsMXeXF9.js";
import "./pairing-labels-CwNfxU8A.js";
import "./memory-cli-0jUpjzpy.js";
import "./manager-BsdWDVhv.js";
import "./query-expansion-B5Pcn5jg.js";
import { t as formatDocsLink } from "./links-dO-svE2W.js";
import "./cli-utils-DWSfnwCw.js";
import "./help-format-DskjS4bd.js";
import "./progress-CAPOQFI0.js";
import "./plugin-registry-Cc_8M5Qu.js";
import { n as resolveCliChannelOptions } from "./channel-options-PZjFpaco.js";
import { t as getSubCliCommandsWithSubcommands } from "./register.subclis-C_q_SL4b.js";
import { a as registerProgramCommands, r as getCoreCliCommandsWithSubcommands } from "./command-registry-CJt0U1Nk.js";
import { r as setProgramContext } from "./program-context-Cs5fHpgM.js";
import { t as forceFreePort } from "./ports-B8tuH_2q.js";
import { n as formatCliBannerLine, r as hasEmittedCliBanner, t as emitCliBanner } from "./banner-C3GzwHl3.js";
import { Command, InvalidArgumentError } from "commander";

//#region src/cli/program/context.ts
function createProgramContext() {
	let cachedChannelOptions;
	const getChannelOptions = () => {
		if (cachedChannelOptions === void 0) cachedChannelOptions = resolveCliChannelOptions();
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
//#region src/cli/log-level-option.ts
const CLI_LOG_LEVEL_VALUES = ALLOWED_LOG_LEVELS.join("|");
function parseCliLogLevelOption(value) {
	const parsed = tryParseLogLevel(value);
	if (!parsed) throw new InvalidArgumentError(`Invalid --log-level (use ${CLI_LOG_LEVEL_VALUES})`);
	return parsed;
}

//#endregion
//#region src/cli/program/help.ts
const CLI_NAME = resolveCliName();
const CLI_NAME_PATTERN = escapeRegExp(CLI_NAME);
const ROOT_COMMANDS_WITH_SUBCOMMANDS = new Set([...getCoreCliCommandsWithSubcommands(), ...getSubCliCommandsWithSubcommands()]);
const ROOT_COMMANDS_HINT = "Hint: commands suffixed with * have subcommands. Run <command> --help for details.";
const EXAMPLES = [
	["openclaw models --help", "Show detailed help for the models command."],
	["openclaw channels login --verbose", "Link personal WhatsApp Web and show QR + connection logs."],
	["openclaw message send --target +15555550123 --message \"Hi\" --json", "Send via your web session and print JSON result."],
	["openclaw gateway --port 18789", "Run the WebSocket Gateway locally."],
	["openclaw --dev gateway", "Run a dev Gateway (isolated state/config) on ws://127.0.0.1:19001."],
	["openclaw gateway --force", "Kill anything bound to the default gateway port, then start it."],
	["openclaw gateway ...", "Gateway control via WebSocket."],
	["openclaw agent --to +15555550123 --message \"Run summary\" --deliver", "Talk directly to the agent using the Gateway; optionally send the WhatsApp reply."],
	["openclaw message send --channel telegram --target @mychat --message \"Hi\"", "Send via your Telegram bot."]
];
function configureProgramHelp(program, ctx) {
	program.name(CLI_NAME).description("").version(ctx.programVersion).option("--dev", "Dev profile: isolate state under ~/.openclaw-dev, default gateway port 19001, and shift derived ports (browser/canvas)").option("--profile <name>", "Use a named profile (isolates OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH under ~/.openclaw-<name>)").option("--log-level <level>", `Global log level override for file + console (${CLI_LOG_LEVEL_VALUES})`, parseCliLogLevelOption);
	program.option("--no-color", "Disable ANSI colors", false);
	program.helpOption("-h, --help", "Display help for command");
	program.helpCommand("help [command]", "Display help for command");
	program.configureHelp({
		sortSubcommands: true,
		sortOptions: true,
		optionTerm: (option) => theme.option(option.flags),
		subcommandTerm: (cmd) => {
			const hasSubcommands = cmd.parent === program && ROOT_COMMANDS_WITH_SUBCOMMANDS.has(cmd.name());
			return theme.command(hasSubcommands ? `${cmd.name()} *` : cmd.name());
		}
	});
	const formatHelpOutput = (str) => {
		let output = str;
		if (new RegExp(`^Usage:\\s+${CLI_NAME_PATTERN}\\s+\\[options\\]\\s+\\[command\\]\\s*$`, "m").test(output) && /^Commands:/m.test(output)) output = output.replace(/^Commands:/m, `Commands:\n  ${theme.muted(ROOT_COMMANDS_HINT)}`);
		return output.replace(/^Usage:/gm, theme.heading("Usage:")).replace(/^Options:/gm, theme.heading("Options:")).replace(/^Commands:/gm, theme.heading("Commands:"));
	};
	program.configureOutput({
		writeOut: (str) => {
			process.stdout.write(formatHelpOutput(str));
		},
		writeErr: (str) => {
			process.stderr.write(formatHelpOutput(str));
		},
		outputError: (str, write) => write(theme.error(str))
	});
	if (hasFlag(process.argv, "-V") || hasFlag(process.argv, "--version") || hasRootVersionAlias(process.argv)) {
		console.log(ctx.programVersion);
		process.exit(0);
	}
	program.addHelpText("beforeAll", () => {
		if (hasEmittedCliBanner()) return "";
		const rich = isRich();
		return `\n${formatCliBannerLine(ctx.programVersion, { richTty: rich })}\n`;
	});
	const fmtExamples = EXAMPLES.map(([cmd, desc]) => `  ${theme.command(replaceCliName(cmd, CLI_NAME))}\n    ${theme.muted(desc)}`).join("\n");
	program.addHelpText("afterAll", ({ command }) => {
		if (command !== program) return "";
		const docs = formatDocsLink("/cli", "docs.openclaw.ai/cli");
		return `\n${theme.heading("Examples:")}\n${fmtExamples}\n\n${theme.muted("Docs:")} ${docs}\n`;
	});
}

//#endregion
//#region src/cli/program/preaction.ts
function setProcessTitleForCommand(actionCommand) {
	let current = actionCommand;
	while (current.parent && current.parent.parent) current = current.parent;
	const name = current.name();
	const cliName = resolveCliName();
	if (!name || name === cliName) return;
	process.title = `${cliName}-${name}`;
}
const PLUGIN_REQUIRED_COMMANDS = new Set([
	"message",
	"channels",
	"directory",
	"agents",
	"configure",
	"onboard"
]);
const CONFIG_GUARD_BYPASS_COMMANDS = new Set([
	"doctor",
	"completion",
	"secrets"
]);
const JSON_PARSE_ONLY_COMMANDS = new Set(["config set"]);
let configGuardModulePromise;
let pluginRegistryModulePromise;
function shouldBypassConfigGuard(commandPath) {
	const [primary, secondary] = commandPath;
	if (!primary) return false;
	if (CONFIG_GUARD_BYPASS_COMMANDS.has(primary)) return true;
	if (primary === "config" && secondary === "validate") return true;
	return false;
}
function loadConfigGuardModule() {
	configGuardModulePromise ??= import("./config-guard-D8L1THTw.js").then((n) => n.t);
	return configGuardModulePromise;
}
function loadPluginRegistryModule() {
	pluginRegistryModulePromise ??= import("./plugin-registry-Cc_8M5Qu.js").then((n) => n.n);
	return pluginRegistryModulePromise;
}
function getRootCommand(command) {
	let current = command;
	while (current.parent) current = current.parent;
	return current;
}
function getCliLogLevel(actionCommand) {
	const root = getRootCommand(actionCommand);
	if (typeof root.getOptionValueSource !== "function") return;
	if (root.getOptionValueSource("logLevel") !== "cli") return;
	const logLevel = root.opts().logLevel;
	return typeof logLevel === "string" ? logLevel : void 0;
}
function isJsonOutputMode(commandPath, argv) {
	if (!hasFlag(argv, "--json")) return false;
	const key = `${commandPath[0] ?? ""} ${commandPath[1] ?? ""}`.trim();
	if (JSON_PARSE_ONLY_COMMANDS.has(key)) return false;
	return true;
}
function registerPreActionHooks(program, programVersion) {
	program.hook("preAction", async (_thisCommand, actionCommand) => {
		setProcessTitleForCommand(actionCommand);
		const argv = process.argv;
		if (hasHelpOrVersion(argv)) return;
		const commandPath = getCommandPathWithRootOptions(argv, 2);
		if (!(isTruthyEnvValue(process.env.OPENCLAW_HIDE_BANNER) || commandPath[0] === "update" || commandPath[0] === "completion" || commandPath[0] === "plugins" && commandPath[1] === "update")) emitCliBanner(programVersion);
		const verbose = getVerboseFlag(argv, { includeDebug: true });
		setVerbose(verbose);
		{
			const { loadConfig } = await import("./auth-profiles-B1fxmUx1.js").then((n) => n.F);
			const cfg = loadConfig();
			if (cfg.cli?.devMode) {
				setDevMode(true);
				const { setConfigOverride } = await import("./runtime-overrides-ChuaKEss.js").then((n) => n.i);
				const path = await import("node:path");
				const { fileURLToPath } = await import("node:url");
				const thisDir = path.dirname(fileURLToPath(import.meta.url));
				const hubPluginPath = path.resolve(thisDir, "../../../dev-mode/hub");
				const currentPaths = cfg.plugins?.load?.paths ?? [];
				if (!currentPaths.includes(hubPluginPath)) setConfigOverride("plugins.load.paths", [...currentPaths, hubPluginPath]);
			}
		}
		const cliLogLevel = getCliLogLevel(actionCommand);
		if (cliLogLevel) process.env.OPENCLAW_LOG_LEVEL = cliLogLevel;
		if (!verbose) process.env.NODE_NO_WARNINGS ??= "1";
		if (shouldBypassConfigGuard(commandPath)) return;
		const suppressDoctorStdout = isJsonOutputMode(commandPath, argv);
		const { ensureConfigReady } = await loadConfigGuardModule();
		await ensureConfigReady({
			runtime: defaultRuntime,
			commandPath,
			...suppressDoctorStdout ? { suppressDoctorStdout: true } : {}
		});
		if (PLUGIN_REQUIRED_COMMANDS.has(commandPath[0])) {
			const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
			ensurePluginRegistryLoaded();
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