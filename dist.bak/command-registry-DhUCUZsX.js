import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { fn as hasHelpOrVersion, ln as getPrimaryCommand } from "./entry.js";
import { i as registerSubCliCommands, o as removeCommandByName, s as reparseProgramFromActionArgs } from "./register.subclis-BgSy4ogj.js";

//#region src/cli/program/command-registry.ts
var command_registry_exports = /* @__PURE__ */ __exportAll({
	getCoreCliCommandNames: () => getCoreCliCommandNames,
	getCoreCliCommandsWithSubcommands: () => getCoreCliCommandsWithSubcommands,
	registerCoreCliByName: () => registerCoreCliByName,
	registerCoreCliCommands: () => registerCoreCliCommands,
	registerProgramCommands: () => registerProgramCommands
});
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
			(await import("./register.setup-DZX9p6hd.js")).registerSetupCommand(program);
		}
	},
	{
		commands: [{
			name: "onboard",
			description: "Interactive onboarding wizard for gateway, workspace, and skills",
			hasSubcommands: false
		}],
		register: async ({ program }) => {
			(await import("./register.onboard-CodYFoMO.js")).registerOnboardCommand(program);
		}
	},
	{
		commands: [{
			name: "configure",
			description: "Interactive setup wizard for credentials, channels, gateway, and agent defaults",
			hasSubcommands: false
		}],
		register: async ({ program }) => {
			(await import("./register.configure-D1ZVlOji.js")).registerConfigureCommand(program);
		}
	},
	{
		commands: [{
			name: "config",
			description: "Non-interactive config helpers (get/set/unset). Default: starts setup wizard.",
			hasSubcommands: true
		}],
		register: async ({ program }) => {
			(await import("./config-cli-DQ5uiHYm.js")).registerConfigCli(program);
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
			(await import("./register.maintenance-D25qgcQt.js")).registerMaintenanceCommands(program);
		}
	},
	{
		commands: [{
			name: "message",
			description: "Send, read, and manage messages",
			hasSubcommands: true
		}],
		register: async ({ program, ctx }) => {
			(await import("./register.message-DhBAGC-M.js")).registerMessageCommands(program, ctx);
		}
	},
	{
		commands: [{
			name: "memory",
			description: "Search and reindex memory files",
			hasSubcommands: true
		}],
		register: async ({ program }) => {
			(await import("./memory-cli-B3-7mJVU.js").then((n) => n.t)).registerMemoryCli(program);
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
			(await import("./register.agent-DhgnhANX.js")).registerAgentCommands(program, { agentChannelOptions: ctx.agentChannelOptions });
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
			(await import("./register.status-health-sessions-DOTuSnL1.js")).registerStatusHealthSessionsCommands(program);
		}
	},
	{
		commands: [{
			name: "browser",
			description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
			hasSubcommands: true
		}],
		register: async ({ program }) => {
			(await import("./browser-cli-F1eUOwj2.js")).registerBrowserCli(program);
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
export { registerProgramCommands as a, registerCoreCliByName as i, getCoreCliCommandNames as n, getCoreCliCommandsWithSubcommands as r, command_registry_exports as t };