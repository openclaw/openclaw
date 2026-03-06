import { L as hasHelpOrVersion, M as buildParseArgv, P as getPrimaryCommand } from "./globals-DBA9iEt5.js";
import { t as isTruthyEnvValue } from "./env-BfNMiMlQ.js";
import { r as resolveActionArgs } from "./helpers-DGBa5iKd.js";

//#region src/cli/program/action-reparse.ts
async function reparseProgramFromActionArgs(program, actionArgs) {
	const actionCommand = actionArgs.at(-1);
	const rawArgs = (actionCommand?.parent ?? program).rawArgs;
	const actionArgsList = resolveActionArgs(actionCommand);
	const fallbackArgv = actionCommand?.name() ? [actionCommand.name(), ...actionArgsList] : actionArgsList;
	const parseArgv = buildParseArgv({
		programName: program.name(),
		rawArgs,
		fallbackArgv
	});
	await program.parseAsync(parseArgv);
}

//#endregion
//#region src/cli/program/command-tree.ts
function removeCommand(program, command) {
	const commands = program.commands;
	const index = commands.indexOf(command);
	if (index < 0) return false;
	commands.splice(index, 1);
	return true;
}
function removeCommandByName(program, name) {
	const existing = program.commands.find((command) => command.name() === name);
	if (!existing) return false;
	return removeCommand(program, existing);
}

//#endregion
//#region src/cli/program/register.subclis.ts
const shouldRegisterPrimaryOnly = (argv) => {
	if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS)) return false;
	if (hasHelpOrVersion(argv)) return false;
	return true;
};
const shouldEagerRegisterSubcommands = (_argv) => {
	return isTruthyEnvValue(process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS);
};
const loadConfig = async () => {
	return (await import("./model-selection-Dmiyt9yA.js").then((n) => n.Yt)).loadConfig();
};
const entries = [
	{
		name: "acp",
		description: "Agent Control Protocol tools",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./acp-cli-C955zMUt.js")).registerAcpCli(program);
		}
	},
	{
		name: "gateway",
		description: "Run, inspect, and query the WebSocket Gateway",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./gateway-cli-C3RY_uCs.js")).registerGatewayCli(program);
		}
	},
	{
		name: "daemon",
		description: "Gateway service (legacy alias)",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./daemon-cli-D9nu8qXm.js").then((n) => n.t)).registerDaemonCli(program);
		}
	},
	{
		name: "logs",
		description: "Tail gateway file logs via RPC",
		hasSubcommands: false,
		register: async (program) => {
			(await import("./logs-cli-Dxsocp1r.js")).registerLogsCli(program);
		}
	},
	{
		name: "system",
		description: "System events, heartbeat, and presence",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./system-cli-DvOMZKjL.js")).registerSystemCli(program);
		}
	},
	{
		name: "models",
		description: "Discover, scan, and configure models",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./models-cli-BCRJA8uB.js")).registerModelsCli(program);
		}
	},
	{
		name: "approvals",
		description: "Manage exec approvals (gateway or node host)",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./exec-approvals-cli-DDQO1WEN.js")).registerExecApprovalsCli(program);
		}
	},
	{
		name: "nodes",
		description: "Manage gateway-owned node pairing and node commands",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./nodes-cli-lDaOi4r2.js")).registerNodesCli(program);
		}
	},
	{
		name: "devices",
		description: "Device pairing + token management",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./devices-cli-eSIdSUgG.js")).registerDevicesCli(program);
		}
	},
	{
		name: "node",
		description: "Run and manage the headless node host service",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./node-cli-DTwFDZA8.js")).registerNodeCli(program);
		}
	},
	{
		name: "sandbox",
		description: "Manage sandbox containers for agent isolation",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./sandbox-cli-CQ1QB9ii.js")).registerSandboxCli(program);
		}
	},
	{
		name: "tui",
		description: "Open a terminal UI connected to the Gateway",
		hasSubcommands: false,
		register: async (program) => {
			(await import("./tui-cli-B8StkMcp.js")).registerTuiCli(program);
		}
	},
	{
		name: "cron",
		description: "Manage cron jobs via the Gateway scheduler",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./cron-cli-dvcXyAFg.js")).registerCronCli(program);
		}
	},
	{
		name: "dns",
		description: "DNS helpers for wide-area discovery (Tailscale + CoreDNS)",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./dns-cli-PZCArLkE.js")).registerDnsCli(program);
		}
	},
	{
		name: "docs",
		description: "Search the live OpenClaw docs",
		hasSubcommands: false,
		register: async (program) => {
			(await import("./docs-cli-D1pMB_I-.js")).registerDocsCli(program);
		}
	},
	{
		name: "hooks",
		description: "Manage internal agent hooks",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./hooks-cli-Bp3185LG.js")).registerHooksCli(program);
		}
	},
	{
		name: "webhooks",
		description: "Webhook helpers and integrations",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./webhooks-cli-BsrrIWwK.js")).registerWebhooksCli(program);
		}
	},
	{
		name: "qr",
		description: "Generate iOS pairing QR/setup code",
		hasSubcommands: false,
		register: async (program) => {
			(await import("./qr-cli-C1Glz1s_.js").then((n) => n.t)).registerQrCli(program);
		}
	},
	{
		name: "clawbot",
		description: "Legacy clawbot command aliases",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./clawbot-cli-BOJvKKPk.js")).registerClawbotCli(program);
		}
	},
	{
		name: "pairing",
		description: "Secure DM pairing (approve inbound requests)",
		hasSubcommands: true,
		register: async (program) => {
			const { registerPluginCliCommands } = await import("./cli-BUuE-uF0.js");
			registerPluginCliCommands(program, await loadConfig());
			(await import("./pairing-cli-obxIBw_q.js")).registerPairingCli(program);
		}
	},
	{
		name: "plugins",
		description: "Manage OpenClaw plugins and extensions",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./plugins-cli-CtaC9O9P.js")).registerPluginsCli(program);
			const { registerPluginCliCommands } = await import("./cli-BUuE-uF0.js");
			registerPluginCliCommands(program, await loadConfig());
		}
	},
	{
		name: "channels",
		description: "Manage connected chat channels (Telegram, Discord, etc.)",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./channels-cli-DSNy5IfC.js")).registerChannelsCli(program);
		}
	},
	{
		name: "directory",
		description: "Lookup contact and group IDs (self, peers, groups) for supported chat channels",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./directory-cli-xGMwl9KS.js")).registerDirectoryCli(program);
		}
	},
	{
		name: "security",
		description: "Security tools and local config audits",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./security-cli-CrkLrMzd.js")).registerSecurityCli(program);
		}
	},
	{
		name: "secrets",
		description: "Secrets runtime reload controls",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./secrets-cli-CA3PPmjT.js")).registerSecretsCli(program);
		}
	},
	{
		name: "skills",
		description: "List and inspect available skills",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./skills-cli-CQiHgqFA.js")).registerSkillsCli(program);
		}
	},
	{
		name: "update",
		description: "Update OpenClaw and inspect update channel status",
		hasSubcommands: true,
		register: async (program) => {
			(await import("./update-cli-DvYlvQjC.js")).registerUpdateCli(program);
		}
	},
	{
		name: "completion",
		description: "Generate shell completion script",
		hasSubcommands: false,
		register: async (program) => {
			(await import("./completion-cli-Bju8znCc.js").then((n) => n.n)).registerCompletionCli(program);
		}
	}
];
function getSubCliEntries() {
	return entries;
}
function getSubCliCommandsWithSubcommands() {
	return entries.filter((entry) => entry.hasSubcommands).map((entry) => entry.name);
}
async function registerSubCliByName(program, name) {
	const entry = entries.find((candidate) => candidate.name === name);
	if (!entry) return false;
	removeCommandByName(program, entry.name);
	await entry.register(program);
	return true;
}
function registerLazyCommand(program, entry) {
	const placeholder = program.command(entry.name).description(entry.description);
	placeholder.allowUnknownOption(true);
	placeholder.allowExcessArguments(true);
	placeholder.action(async (...actionArgs) => {
		removeCommand(program, placeholder);
		await entry.register(program);
		await reparseProgramFromActionArgs(program, actionArgs);
	});
}
function registerSubCliCommands(program, argv = process.argv) {
	if (shouldEagerRegisterSubcommands(argv)) {
		for (const entry of entries) entry.register(program);
		return;
	}
	const primary = getPrimaryCommand(argv);
	if (primary && shouldRegisterPrimaryOnly(argv)) {
		const entry = entries.find((candidate) => candidate.name === primary);
		if (entry) {
			registerLazyCommand(program, entry);
			return;
		}
	}
	for (const candidate of entries) registerLazyCommand(program, candidate);
}

//#endregion
//#region src/cli/program/command-registry.ts
const shouldRegisterCorePrimaryOnly = (argv) => {
	if (hasHelpOrVersion(argv)) return false;
	return true;
};
const coreEntries = [
	{
		commands: [{
			name: "setup",
			description: "Initialize local config and agent workspace",
			hasSubcommands: false
		}],
		register: async ({ program }) => {
			(await import("./register.setup-fN1fQ0ow.js")).registerSetupCommand(program);
		}
	},
	{
		commands: [{
			name: "onboard",
			description: "Interactive onboarding wizard for gateway, workspace, and skills",
			hasSubcommands: false
		}],
		register: async ({ program }) => {
			(await import("./register.onboard-C2CTAHq9.js")).registerOnboardCommand(program);
		}
	},
	{
		commands: [{
			name: "configure",
			description: "Interactive setup wizard for credentials, channels, gateway, and agent defaults",
			hasSubcommands: false
		}],
		register: async ({ program }) => {
			(await import("./register.configure-CpC3dQZt.js")).registerConfigureCommand(program);
		}
	},
	{
		commands: [{
			name: "config",
			description: "Non-interactive config helpers (get/set/unset/file/validate). Default: starts setup wizard.",
			hasSubcommands: true
		}],
		register: async ({ program }) => {
			(await import("./config-cli-BKWf09nQ.js")).registerConfigCli(program);
		}
	},
	{
		commands: [
			{
				name: "doctor",
				description: "Health checks + quick fixes for the gateway and channels",
				hasSubcommands: false
			},
			{
				name: "dashboard",
				description: "Open the Control UI with your current token",
				hasSubcommands: false
			},
			{
				name: "reset",
				description: "Reset local config/state (keeps the CLI installed)",
				hasSubcommands: false
			},
			{
				name: "uninstall",
				description: "Uninstall the gateway service + local data (CLI remains)",
				hasSubcommands: false
			}
		],
		register: async ({ program }) => {
			(await import("./register.maintenance-DYL2xTIk.js")).registerMaintenanceCommands(program);
		}
	},
	{
		commands: [{
			name: "message",
			description: "Send, read, and manage messages",
			hasSubcommands: true
		}],
		register: async ({ program, ctx }) => {
			(await import("./register.message-BWd7_OhE.js")).registerMessageCommands(program, ctx);
		}
	},
	{
		commands: [{
			name: "memory",
			description: "Search and reindex memory files",
			hasSubcommands: true
		}],
		register: async ({ program }) => {
			(await import("./memory-cli-CKGyP5m4.js").then((n) => n.t)).registerMemoryCli(program);
		}
	},
	{
		commands: [{
			name: "agent",
			description: "Run one agent turn via the Gateway",
			hasSubcommands: false
		}, {
			name: "agents",
			description: "Manage isolated agents (workspaces, auth, routing)",
			hasSubcommands: true
		}],
		register: async ({ program, ctx }) => {
			(await import("./register.agent-CZD4EQBG.js")).registerAgentCommands(program, { agentChannelOptions: ctx.agentChannelOptions });
		}
	},
	{
		commands: [
			{
				name: "status",
				description: "Show channel health and recent session recipients",
				hasSubcommands: false
			},
			{
				name: "health",
				description: "Fetch health from the running gateway",
				hasSubcommands: false
			},
			{
				name: "sessions",
				description: "List stored conversation sessions",
				hasSubcommands: true
			}
		],
		register: async ({ program }) => {
			(await import("./register.status-health-sessions-BvIp6soK.js")).registerStatusHealthSessionsCommands(program);
		}
	},
	{
		commands: [{
			name: "browser",
			description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
			hasSubcommands: true
		}],
		register: async ({ program }) => {
			(await import("./browser-cli-BmVoTl20.js")).registerBrowserCli(program);
		}
	}
];
function collectCoreCliCommandNames(predicate) {
	const seen = /* @__PURE__ */ new Set();
	const names = [];
	for (const entry of coreEntries) for (const command of entry.commands) {
		if (predicate && !predicate(command)) continue;
		if (seen.has(command.name)) continue;
		seen.add(command.name);
		names.push(command.name);
	}
	return names;
}
function getCoreCliCommandNames() {
	return collectCoreCliCommandNames();
}
function getCoreCliCommandsWithSubcommands() {
	return collectCoreCliCommandNames((command) => command.hasSubcommands);
}
function removeEntryCommands(program, entry) {
	for (const cmd of entry.commands) removeCommandByName(program, cmd.name);
}
function registerLazyCoreCommand(program, ctx, entry, command) {
	const placeholder = program.command(command.name).description(command.description);
	placeholder.allowUnknownOption(true);
	placeholder.allowExcessArguments(true);
	placeholder.action(async (...actionArgs) => {
		removeEntryCommands(program, entry);
		await entry.register({
			program,
			ctx,
			argv: process.argv
		});
		await reparseProgramFromActionArgs(program, actionArgs);
	});
}
async function registerCoreCliByName(program, ctx, name, argv = process.argv) {
	const entry = coreEntries.find((candidate) => candidate.commands.some((cmd) => cmd.name === name));
	if (!entry) return false;
	removeEntryCommands(program, entry);
	await entry.register({
		program,
		ctx,
		argv
	});
	return true;
}
function registerCoreCliCommands(program, ctx, argv) {
	const primary = getPrimaryCommand(argv);
	if (primary && shouldRegisterCorePrimaryOnly(argv)) {
		const entry = coreEntries.find((candidate) => candidate.commands.some((cmd) => cmd.name === primary));
		if (entry) {
			const cmd = entry.commands.find((c) => c.name === primary);
			if (cmd) registerLazyCoreCommand(program, ctx, entry, cmd);
			return;
		}
	}
	for (const entry of coreEntries) for (const cmd of entry.commands) registerLazyCoreCommand(program, ctx, entry, cmd);
}
function registerProgramCommands(program, ctx, argv = process.argv) {
	registerCoreCliCommands(program, ctx, argv);
	registerSubCliCommands(program, argv);
}

//#endregion
//#region src/cli/program/program-context.ts
const PROGRAM_CONTEXT_SYMBOL = Symbol.for("openclaw.cli.programContext");
function setProgramContext(program, ctx) {
	program[PROGRAM_CONTEXT_SYMBOL] = ctx;
}
function getProgramContext(program) {
	return program[PROGRAM_CONTEXT_SYMBOL];
}

//#endregion
export { registerCoreCliByName as a, getSubCliEntries as c, getCoreCliCommandsWithSubcommands as i, registerSubCliByName as l, setProgramContext as n, registerProgramCommands as o, getCoreCliCommandNames as r, getSubCliCommandsWithSubcommands as s, getProgramContext as t };