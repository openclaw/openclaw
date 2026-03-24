#!/usr/bin/env node
import "./paths-BJV7vkaX.js";
import { A as theme, B as tryParseLogLevel, J as hasHelpOrVersion, K as getVerboseFlag, R as ALLOWED_LOG_LEVELS, W as getCommandPathWithRootOptions, Y as hasRootVersionAlias, d as visibleWidth, k as isRich, p as defaultRuntime, q as hasFlag, r as enableConsoleCapture, w as setVerbose } from "./subsystem-DBBM_0ww.js";
import { T as toWhatsappJid, l as escapeRegExp, m as normalizeE164, n as assertWebChannel } from "./utils-JhJvOE-Q.js";
import { Ep as saveSessionStore, Ev as loadDotEnv, Og as ensureBinary, Xp as deriveSessionKey, Zp as resolveSessionKey, ah as describePortOwner, gf as installUnhandledRejectionHandler, ih as PortInUseError, ji as resolveCommitHash, kg as promptYesNo, oh as ensurePortAvailable, sh as handlePortError, t as getReplyFromConfig, uf as applyTemplate, wp as loadSessionStore, x_ as loadConfig, xv as VERSION } from "./reply-C_543Lol.js";
import "./agent-scope-BwZuo7sQ.js";
import "./openclaw-root-CGu4EGX8.js";
import "./logger-B7cfoxgB.js";
import { n as runExec, t as runCommandWithTimeout } from "./exec-eWx7-KTZ.js";
import "./github-copilot-token-DLfBlMRf.js";
import { n as replaceCliName, r as resolveCliName } from "./command-format-p_4ya3m0.js";
import "./boolean-B938tROv.js";
import { r as normalizeEnv, t as isTruthyEnvValue } from "./env-Cb5JzEB2.js";
import "./env-overrides-C-ZXrJon.js";
import "./registry-BbhZ8aJW.js";
import "./skills-3AC6GJLt.js";
import "./frontmatter-BngyYhS0.js";
import "./plugins-By9GTgrF.js";
import "./query-expansion-yWVZ1kDa.js";
import "./redact-ey2aG4c9.js";
import "./path-alias-guards-Cb4NBV2_.js";
import "./fetch-pr82VtKF.js";
import { s as formatUncaughtError } from "./cli-utils-DMoIioWo.js";
import "./delivery-queue-DFrlUHFS.js";
import { l as resolveStorePath } from "./paths-DtZZPyOl.js";
import "./session-cost-usage-CUa3Yrhb.js";
import "./prompt-style-DxRe6Qmy.js";
import { t as formatDocsLink } from "./links-D5--5M_8.js";
import { r as waitForever, t as monitorWebChannel } from "./channel-web-Bk4J2hs3.js";
import "./outbound-BI1uYkag.js";
import "./session-BeYpdxSC.js";
import "./login-DoKpCJWd.js";
import { t as createDefaultDeps } from "./deps-COIZY8Qq.js";
import { t as isMainModule } from "./is-main-Dlg4QvB-.js";
import { t as ensureOpenClawCliOnPath } from "./path-env-udml7YHk.js";
import { t as assertSupportedRuntime } from "./runtime-guard-Dgkrqte4.js";
import "./ports-D4Fv_N2v.js";
import { i as getCoreCliCommandsWithSubcommands, n as setProgramContext, o as registerProgramCommands, s as getSubCliCommandsWithSubcommands } from "./program-context-Br5bYVb2.js";
import "./plugin-registry-rEaDLPVD.js";
import { n as resolveCliChannelOptions } from "./channel-options-C5Lf7hq4.js";
import process$1 from "node:process";
import { fileURLToPath } from "node:url";
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
//#region src/cli/tagline.ts
const DEFAULT_TAGLINE = "All your chats, one OpenClaw.";
const HOLIDAY_TAGLINES = {
	newYear: "New Year's Day: New year, new config—same old EADDRINUSE, but this time we resolve it like grown-ups.",
	lunarNewYear: "Lunar New Year: May your builds be lucky, your branches prosperous, and your merge conflicts chased away with fireworks.",
	christmas: "Christmas: Ho ho ho—Santa's little claw-sistant is here to ship joy, roll back chaos, and stash the keys safely.",
	eid: "Eid al-Fitr: Celebration mode: queues cleared, tasks completed, and good vibes committed to main with clean history.",
	diwali: "Diwali: Let the logs sparkle and the bugs flee—today we light up the terminal and ship with pride.",
	easter: "Easter: I found your missing environment variable—consider it a tiny CLI egg hunt with fewer jellybeans.",
	hanukkah: "Hanukkah: Eight nights, eight retries, zero shame—may your gateway stay lit and your deployments stay peaceful.",
	halloween: "Halloween: Spooky season: beware haunted dependencies, cursed caches, and the ghost of node_modules past.",
	thanksgiving: "Thanksgiving: Grateful for stable ports, working DNS, and a bot that reads the logs so nobody has to.",
	valentines: "Valentine's Day: Roses are typed, violets are piped—I'll automate the chores so you can spend time with humans."
};
const TAGLINES = [
	"Your terminal just grew claws—type something and let the bot pinch the busywork.",
	"Welcome to the command line: where dreams compile and confidence segfaults.",
	"I run on caffeine, JSON5, and the audacity of \"it worked on my machine.\"",
	"Gateway online—please keep hands, feet, and appendages inside the shell at all times.",
	"I speak fluent bash, mild sarcasm, and aggressive tab-completion energy.",
	"One CLI to rule them all, and one more restart because you changed the port.",
	"If it works, it's automation; if it breaks, it's a \"learning opportunity.\"",
	"Pairing codes exist because even bots believe in consent—and good security hygiene.",
	"Your .env is showing; don't worry, I'll pretend I didn't see it.",
	"I'll do the boring stuff while you dramatically stare at the logs like it's cinema.",
	"I'm not saying your workflow is chaotic... I'm just bringing a linter and a helmet.",
	"Type the command with confidence—nature will provide the stack trace if needed.",
	"I don't judge, but your missing API keys are absolutely judging you.",
	"I can grep it, git blame it, and gently roast it—pick your coping mechanism.",
	"Hot reload for config, cold sweat for deploys.",
	"I'm the assistant your terminal demanded, not the one your sleep schedule requested.",
	"I keep secrets like a vault... unless you print them in debug logs again.",
	"Automation with claws: minimal fuss, maximal pinch.",
	"I'm basically a Swiss Army knife, but with more opinions and fewer sharp edges.",
	"If you're lost, run doctor; if you're brave, run prod; if you're wise, run tests.",
	"Your task has been queued; your dignity has been deprecated.",
	"I can't fix your code taste, but I can fix your build and your backlog.",
	"I'm not magic—I'm just extremely persistent with retries and coping strategies.",
	"It's not \"failing,\" it's \"discovering new ways to configure the same thing wrong.\"",
	"Give me a workspace and I'll give you fewer tabs, fewer toggles, and more oxygen.",
	"I read logs so you can keep pretending you don't have to.",
	"If something's on fire, I can't extinguish it—but I can write a beautiful postmortem.",
	"I'll refactor your busywork like it owes me money.",
	"Say \"stop\" and I'll stop—say \"ship\" and we'll both learn a lesson.",
	"I'm the reason your shell history looks like a hacker-movie montage.",
	"I'm like tmux: confusing at first, then suddenly you can't live without me.",
	"I can run local, remote, or purely on vibes—results may vary with DNS.",
	"If you can describe it, I can probably automate it—or at least make it funnier.",
	"Your config is valid, your assumptions are not.",
	"I don't just autocomplete—I auto-commit (emotionally), then ask you to review (logically).",
	"Less clicking, more shipping, fewer \"where did that file go\" moments.",
	"Claws out, commit in—let's ship something mildly responsible.",
	"I'll butter your workflow like a lobster roll: messy, delicious, effective.",
	"Shell yeah—I'm here to pinch the toil and leave you the glory.",
	"If it's repetitive, I'll automate it; if it's hard, I'll bring jokes and a rollback plan.",
	"The only crab in your contacts you actually want to hear from. 🦞",
	"WhatsApp automation without the \"please accept our new privacy policy\".",
	"iMessage green bubble energy, but for everyone.",
	"No $999 stand required.",
	"We ship features faster than Apple ships calculator updates.",
	"Your AI assistant, now without the $3,499 headset.",
	"Ah, the fruit tree company! 🍎",
	"Greetings, Professor Falken",
	"I don't sleep, I just enter low-power mode and dream of clean diffs.",
	"Your personal assistant, minus the passive-aggressive calendar reminders.",
	"Built by lobsters, for humans. Don't question the hierarchy.",
	"I've seen your commit messages. We'll work on that together.",
	"More integrations than your therapist's intake form.",
	"Running on your hardware, reading your logs, judging nothing (mostly).",
	"The only open-source project where the mascot could eat the competition.",
	"Self-hosted, self-updating, self-aware (just kidding... unless?).",
	"I autocomplete your thoughts—just slower and with more API calls.",
	"Somewhere between 'hello world' and 'oh god what have I built.'",
	"Your .zshrc wishes it could do what I do.",
	"I've read more man pages than any human should—so you don't have to.",
	"Powered by open source, sustained by spite and good documentation.",
	"I'm the middleware between your ambition and your attention span.",
	"Finally, a use for that always-on Mac Mini under your desk.",
	"Like having a senior engineer on call, except I don't bill hourly or sigh audibly.",
	"Making 'I'll automate that later' happen now.",
	"Your second brain, except this one actually remembers where you left things.",
	"Half butler, half debugger, full crustacean.",
	"I don't have opinions about tabs vs spaces. I have opinions about everything else.",
	"Open source means you can see exactly how I judge your config.",
	"I've survived more breaking changes than your last three relationships.",
	"Runs on a Raspberry Pi. Dreams of a rack in Iceland.",
	"The lobster in your shell. 🦞",
	"Alexa, but with taste.",
	"I'm not AI-powered, I'm AI-possessed. Big difference.",
	"Deployed locally, trusted globally, debugged eternally.",
	"You had me at 'openclaw gateway start.'",
	HOLIDAY_TAGLINES.newYear,
	HOLIDAY_TAGLINES.lunarNewYear,
	HOLIDAY_TAGLINES.christmas,
	HOLIDAY_TAGLINES.eid,
	HOLIDAY_TAGLINES.diwali,
	HOLIDAY_TAGLINES.easter,
	HOLIDAY_TAGLINES.hanukkah,
	HOLIDAY_TAGLINES.halloween,
	HOLIDAY_TAGLINES.thanksgiving,
	HOLIDAY_TAGLINES.valentines
];
const DAY_MS = 1440 * 60 * 1e3;
function utcParts(date) {
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth(),
		day: date.getUTCDate()
	};
}
const onMonthDay = (month, day) => (date) => {
	const parts = utcParts(date);
	return parts.month === month && parts.day === day;
};
const onSpecificDates = (dates, durationDays = 1) => (date) => {
	const parts = utcParts(date);
	return dates.some(([year, month, day]) => {
		if (parts.year !== year) return false;
		const start = Date.UTC(year, month, day);
		const current = Date.UTC(parts.year, parts.month, parts.day);
		return current >= start && current < start + durationDays * DAY_MS;
	});
};
const inYearWindow = (windows) => (date) => {
	const parts = utcParts(date);
	const window = windows.find((entry) => entry.year === parts.year);
	if (!window) return false;
	const start = Date.UTC(window.year, window.month, window.day);
	const current = Date.UTC(parts.year, parts.month, parts.day);
	return current >= start && current < start + window.duration * DAY_MS;
};
const isFourthThursdayOfNovember = (date) => {
	const parts = utcParts(date);
	if (parts.month !== 10) return false;
	const fourthThursday = 1 + (4 - new Date(Date.UTC(parts.year, 10, 1)).getUTCDay() + 7) % 7 + 21;
	return parts.day === fourthThursday;
};
const HOLIDAY_RULES = new Map([
	[HOLIDAY_TAGLINES.newYear, onMonthDay(0, 1)],
	[HOLIDAY_TAGLINES.lunarNewYear, onSpecificDates([
		[
			2025,
			0,
			29
		],
		[
			2026,
			1,
			17
		],
		[
			2027,
			1,
			6
		]
	], 1)],
	[HOLIDAY_TAGLINES.eid, onSpecificDates([
		[
			2025,
			2,
			30
		],
		[
			2025,
			2,
			31
		],
		[
			2026,
			2,
			20
		],
		[
			2027,
			2,
			10
		]
	], 1)],
	[HOLIDAY_TAGLINES.diwali, onSpecificDates([
		[
			2025,
			9,
			20
		],
		[
			2026,
			10,
			8
		],
		[
			2027,
			9,
			28
		]
	], 1)],
	[HOLIDAY_TAGLINES.easter, onSpecificDates([
		[
			2025,
			3,
			20
		],
		[
			2026,
			3,
			5
		],
		[
			2027,
			2,
			28
		]
	], 1)],
	[HOLIDAY_TAGLINES.hanukkah, inYearWindow([
		{
			year: 2025,
			month: 11,
			day: 15,
			duration: 8
		},
		{
			year: 2026,
			month: 11,
			day: 5,
			duration: 8
		},
		{
			year: 2027,
			month: 11,
			day: 25,
			duration: 8
		}
	])],
	[HOLIDAY_TAGLINES.halloween, onMonthDay(9, 31)],
	[HOLIDAY_TAGLINES.thanksgiving, isFourthThursdayOfNovember],
	[HOLIDAY_TAGLINES.valentines, onMonthDay(1, 14)],
	[HOLIDAY_TAGLINES.christmas, onMonthDay(11, 25)]
]);
function isTaglineActive(tagline, date) {
	const rule = HOLIDAY_RULES.get(tagline);
	if (!rule) return true;
	return rule(date);
}
function activeTaglines(options = {}) {
	if (TAGLINES.length === 0) return [DEFAULT_TAGLINE];
	const today = options.now ? options.now() : /* @__PURE__ */ new Date();
	const filtered = TAGLINES.filter((tagline) => isTaglineActive(tagline, today));
	return filtered.length > 0 ? filtered : TAGLINES;
}
function pickTagline(options = {}) {
	if (options.mode === "off") return "";
	if (options.mode === "default") return DEFAULT_TAGLINE;
	const override = (options.env ?? process.env)?.OPENCLAW_TAGLINE_INDEX;
	if (override !== void 0) {
		const parsed = Number.parseInt(override, 10);
		if (!Number.isNaN(parsed) && parsed >= 0) {
			const pool = TAGLINES.length > 0 ? TAGLINES : [DEFAULT_TAGLINE];
			return pool[parsed % pool.length];
		}
	}
	const pool = activeTaglines(options);
	const rand = options.random ?? Math.random;
	return pool[Math.floor(rand() * pool.length) % pool.length];
}
//#endregion
//#region src/cli/banner.ts
let bannerEmitted = false;
typeof Intl !== "undefined" && "Segmenter" in Intl && new Intl.Segmenter(void 0, { granularity: "grapheme" });
const hasJsonFlag = (argv) => argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
const hasVersionFlag = (argv) => argv.some((arg) => arg === "--version" || arg === "-V") || hasRootVersionAlias(argv);
function parseTaglineMode(value) {
	if (value === "random" || value === "default" || value === "off") return value;
}
function resolveTaglineMode(options) {
	const explicit = parseTaglineMode(options.mode);
	if (explicit) return explicit;
	try {
		return parseTaglineMode(loadConfig().cli?.banner?.taglineMode);
	} catch {
		return;
	}
}
function formatCliBannerLine(version, options = {}) {
	const commitLabel = options.commit ?? resolveCommitHash({
		env: options.env,
		moduleUrl: import.meta.url
	}) ?? "unknown";
	const tagline = pickTagline({
		...options,
		mode: resolveTaglineMode(options)
	});
	const rich = options.richTty ?? isRich();
	const title = "🦞 OpenClaw";
	const columns = options.columns ?? process.stdout.columns ?? 120;
	const plainBaseLine = `${title} ${version} (${commitLabel})`;
	const plainFullLine = tagline ? `${plainBaseLine} — ${tagline}` : plainBaseLine;
	const fitsOnOneLine = visibleWidth(plainFullLine) <= columns;
	if (rich) {
		if (fitsOnOneLine) {
			if (!tagline) return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(`(${commitLabel})`)}`;
			return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(`(${commitLabel})`)} ${theme.muted("—")} ${theme.accentDim(tagline)}`;
		}
		const line1 = `${theme.heading(title)} ${theme.info(version)} ${theme.muted(`(${commitLabel})`)}`;
		if (!tagline) return line1;
		return `${line1}\n${`${" ".repeat(3)}${theme.accentDim(tagline)}`}`;
	}
	if (fitsOnOneLine) return plainFullLine;
	const line1 = plainBaseLine;
	if (!tagline) return line1;
	return `${line1}\n${`${" ".repeat(3)}${tagline}`}`;
}
function emitCliBanner(version, options = {}) {
	if (bannerEmitted) return;
	const argv = options.argv ?? process.argv;
	if (!process.stdout.isTTY) return;
	if (hasJsonFlag(argv)) return;
	if (hasVersionFlag(argv)) return;
	const line = formatCliBannerLine(version, options);
	process.stdout.write(`\n${line}\n\n`);
	bannerEmitted = true;
}
function hasEmittedCliBanner() {
	return bannerEmitted;
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
		const commit = resolveCommitHash({ moduleUrl: import.meta.url });
		console.log(commit ? `OpenClaw ${ctx.programVersion} (${commit})` : `OpenClaw ${ctx.programVersion}`);
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
	"onboard",
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
	if (!primary) return false;
	if (CONFIG_GUARD_BYPASS_COMMANDS.has(primary)) return true;
	if (primary === "config" && secondary === "validate") return true;
	return false;
}
function loadConfigGuardModule() {
	configGuardModulePromise ??= import("./config-guard-C4-dFipd.js");
	return configGuardModulePromise;
}
function loadPluginRegistryModule() {
	pluginRegistryModulePromise ??= import("./plugin-registry-rEaDLPVD.js").then((n) => n.n);
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
//#region src/index.ts
loadDotEnv({ quiet: true });
normalizeEnv();
ensureOpenClawCliOnPath();
enableConsoleCapture();
assertSupportedRuntime();
const program = buildProgram();
if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
	installUnhandledRejectionHandler();
	process$1.on("uncaughtException", (error) => {
		console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
		process$1.exit(1);
	});
	program.parseAsync(process$1.argv).catch((err) => {
		console.error("[openclaw] CLI failed:", formatUncaughtError(err));
		process$1.exit(1);
	});
}
//#endregion
export { PortInUseError, applyTemplate, assertWebChannel, createDefaultDeps, deriveSessionKey, describePortOwner, ensureBinary, ensurePortAvailable, getReplyFromConfig, handlePortError, loadConfig, loadSessionStore, monitorWebChannel, normalizeE164, promptYesNo, resolveSessionKey, resolveStorePath, runCommandWithTimeout, runExec, saveSessionStore, toWhatsappJid, waitForever };
