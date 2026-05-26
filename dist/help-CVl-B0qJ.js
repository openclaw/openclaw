import { b as getCoreCliCommandsWithSubcommands, c as hasFlag, l as hasRootVersionAlias, m as getSubCliCommandsWithSubcommands, n as getCommandPathWithRootOptions } from "./argv-j42r4Rb7.js";
import { n as resolveCliName, t as replaceCliName } from "./cli-name-C-K1n6ar.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { n as isRich, r as theme } from "./theme-D58JpUfy.js";
import { b as escapeRegExp } from "./utils-sBTEdeml.js";
import { g as ALLOWED_LOG_LEVELS, y as tryParseLogLevel } from "./logger-Dg9dVaLI.js";
import { t as resolveCommitHash } from "./git-commit-ZxWO4cFl.js";
import { i as hasEmittedCliBanner, r as formatCliBannerLine } from "./banner-DmmVIGPk.js";
import { InvalidArgumentError } from "commander";
//#region src/cli/log-level-option.ts
const CLI_LOG_LEVEL_VALUES = ALLOWED_LOG_LEVELS.join("|");
function parseCliLogLevelOption(value) {
	const parsed = tryParseLogLevel(value);
	if (!parsed) throw new InvalidArgumentError(`Invalid --log-level (use ${CLI_LOG_LEVEL_VALUES})`);
	return parsed;
}
//#endregion
//#region src/cli/program/error-output.ts
function stripCommanderErrorPrefix(raw) {
	return raw.trim().replace(/^error:\s*/i, "").trim();
}
function quote(value) {
	return `"${value}"`;
}
function resolveHelpCommand(argv, options) {
	if (options?.root || !argv) return formatCliCommand("openclaw --help");
	const commandPath = getCommandPathWithRootOptions(argv, 2);
	if (commandPath.length === 0) return formatCliCommand("openclaw --help");
	return formatCliCommand(`openclaw ${commandPath.join(" ")} --help`);
}
function lines(...items) {
	return `${items.filter((item) => Boolean(item)).join("\n")}\n`;
}
function formatHelpHint(argv, options) {
	return `${theme.muted("Try:")} ${theme.command(resolveHelpCommand(argv, options))}`;
}
function formatDocsHint() {
	return `${theme.muted("Docs:")} ${formatDocsLink("/cli", "docs.openclaw.ai/cli")}`;
}
function formatCliParseErrorOutput(raw, options = {}) {
	const message = stripCommanderErrorPrefix(raw);
	const unknownCommand = message.match(/^unknown command ['"`](.+?)['"`]/i);
	if (unknownCommand) {
		const command = unknownCommand[1] ?? "";
		return lines(theme.error(`OpenClaw does not know the command ${quote(command)}.`), formatHelpHint(options.argv, { root: true }), `${theme.muted("Plugin command?")} ${theme.command(formatCliCommand("openclaw plugins list"))}`, formatDocsHint());
	}
	const unknownOption = message.match(/^unknown option ['"`](.+?)['"`]/i);
	if (unknownOption) {
		const option = unknownOption[1] ?? "";
		return lines(theme.error(`OpenClaw does not recognize option ${quote(option)}.`), formatHelpHint(options.argv));
	}
	const missingArgument = message.match(/^missing required argument ['"`](.+?)['"`]/i);
	if (missingArgument) {
		const argument = missingArgument[1] ?? "";
		return lines(theme.error(`Missing required argument ${quote(argument)}.`), formatHelpHint(options.argv));
	}
	const missingOption = message.match(/^required option ['"`](.+?)['"`] not specified/i);
	if (missingOption) {
		const option = missingOption[1] ?? "";
		return lines(theme.error(`Missing required option ${quote(option)}.`), formatHelpHint(options.argv));
	}
	if (/^too many arguments\b/i.test(message)) return lines(theme.error("Too many arguments for this command."), formatHelpHint(options.argv));
	return lines(theme.error(`OpenClaw could not parse this command: ${message}`), formatHelpHint(options.argv));
}
//#endregion
//#region src/cli/program/help.ts
const CLI_NAME = resolveCliName();
const CLI_NAME_PATTERN = escapeRegExp(CLI_NAME);
const ROOT_COMMANDS_WITH_SUBCOMMANDS = new Set([...getCoreCliCommandsWithSubcommands(), ...getSubCliCommandsWithSubcommands()]);
const ROOT_COMMANDS_HINT = "Hint: commands suffixed with * have subcommands. Run <command> --help for details.";
const EXAMPLES = [
	["openclaw onboard", "Run guided setup for a local Gateway, workspace, auth, and channels."],
	["openclaw setup", "Create the baseline config, workspace, and session folders."],
	["openclaw configure", "Change models, Gateway, channels, plugins, skills, and health checks."],
	["openclaw status", "Check Gateway, channel, model, and recent-session status."],
	["openclaw doctor --fix", "Repair common config, service, plugin, and channel problems."],
	["openclaw channels add", "Add or update a chat channel account with guided prompts."],
	["openclaw channels status", "See connected messaging accounts and login state."],
	["openclaw --dev gateway", "Run a dev Gateway (isolated state/config) on ws://127.0.0.1:19001."],
	["openclaw gateway run --force", "Start the Gateway and replace anything bound to its port."],
	["openclaw models status", "Show model/provider auth health before running agents."],
	["openclaw plugins list", "Inspect enabled, disabled, and installed plugins."],
	["openclaw agent --to +15555550123 --message \"Run summary\" --deliver", "Run one agent turn through the Gateway and optionally deliver the reply."],
	["openclaw message send --channel telegram --target @mychat --message \"Hi\"", "Send via your Telegram bot."]
];
function configureProgramHelp(program, ctx) {
	program.name(CLI_NAME).description("").version(ctx.programVersion).option("--container <name>", "Run the CLI inside a running Podman/Docker container named <name> (default: env OPENCLAW_CONTAINER)").option("--dev", "Dev profile: isolate state under ~/.openclaw-dev, default gateway port 19001, and shift derived ports (browser/canvas)").option("--profile <name>", "Use a named profile (isolates OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH under ~/.openclaw-<name>)").option("--log-level <level>", `Global log level override for file + console (${CLI_LOG_LEVEL_VALUES})`, parseCliLogLevelOption);
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
		outputError: (str, write) => write(formatCliParseErrorOutput(str, { argv: process.argv }))
	});
	if (hasFlag(process.argv, "-V") || hasFlag(process.argv, "--version") || hasRootVersionAlias(process.argv)) {
		const commit = resolveCommitHash({ moduleUrl: import.meta.url });
		console.log(commit ? `OpenClaw ${ctx.programVersion} (${commit})` : `OpenClaw ${ctx.programVersion}`);
		process.exit(0);
	}
	program.addHelpText("beforeAll", () => {
		if (hasEmittedCliBanner() || process.env.OPENCLAW_SUPPRESS_HELP_BANNER === "1") return "";
		const rich = isRich();
		return `\n${formatCliBannerLine(ctx.programVersion, {
			richTty: rich,
			mode: "default"
		})}\n`;
	});
	const fmtExamples = EXAMPLES.map(([cmd, desc]) => `  ${theme.command(replaceCliName(cmd, CLI_NAME))}\n    ${theme.muted(desc)}`).join("\n");
	program.addHelpText("afterAll", ({ command }) => {
		if (command !== program) return "";
		const docs = formatDocsLink("/cli", "docs.openclaw.ai/cli");
		return `\n${theme.heading("Examples:")}\n${fmtExamples}\n\n${theme.muted("Docs:")} ${docs}\n`;
	});
}
//#endregion
export { configureProgramHelp as t };
