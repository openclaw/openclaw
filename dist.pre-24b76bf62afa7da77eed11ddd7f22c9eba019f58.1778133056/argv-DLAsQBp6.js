import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { t as sanitizeForLog } from "./ansi-Dqm1lzVL.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-CRSCIPqz.js";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/daemon/runtime-binary.ts
const NODE_VERSIONED_PATTERN = /^node(?:-\d+|\d+)(?:\.\d+)*(?:\.exe)?$/;
function normalizeRuntimeBasename(execPath) {
	const trimmed = execPath.trim().replace(/^["']|["']$/g, "");
	const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return normalizeLowercaseStringOrEmpty(lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1));
}
function isNodeRuntime(execPath) {
	const base = normalizeRuntimeBasename(execPath);
	return base === "node" || base === "node.exe" || base === "nodejs" || base === "nodejs.exe" || NODE_VERSIONED_PATTERN.test(base);
}
function isBunRuntime(execPath) {
	const base = normalizeRuntimeBasename(execPath);
	return base === "bun" || base === "bun.exe";
}
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set([
	"--profile",
	"--log-level",
	"--container"
]);
function isValueToken(arg) {
	if (!arg || arg === "--") return false;
	if (!arg.startsWith("-")) return true;
	return /^-\d+(?:\.\d+)?$/.test(arg);
}
function consumeRootOptionToken(args, index) {
	const arg = args[index];
	if (!arg) return 0;
	if (ROOT_BOOLEAN_FLAGS.has(arg)) return 1;
	if (arg.startsWith("--profile=") || arg.startsWith("--log-level=") || arg.startsWith("--container=")) return 1;
	if (ROOT_VALUE_FLAGS.has(arg)) return isValueToken(args[index + 1]) ? 2 : 1;
	return 0;
}
//#endregion
//#region src/cli/program/command-descriptor-utils.ts
const SAFE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function normalizeCommandDescriptorName(name) {
	const normalized = name.trim();
	return SAFE_COMMAND_NAME_PATTERN.test(normalized) ? normalized : null;
}
function assertSafeCommandDescriptorName(name) {
	const normalized = normalizeCommandDescriptorName(name);
	if (!normalized) throw new Error(`Invalid CLI command name: ${JSON.stringify(name.trim())}`);
	return normalized;
}
function sanitizeCommandDescriptorDescription(description) {
	return sanitizeForLog(description).trim();
}
function getCommandDescriptorNames(descriptors) {
	return descriptors.map((descriptor) => descriptor.name);
}
function getCommandsWithSubcommands(descriptors) {
	return descriptors.filter((descriptor) => descriptor.hasSubcommands).map((descriptor) => descriptor.name);
}
function collectUniqueCommandDescriptors(descriptorGroups) {
	const seen = /* @__PURE__ */ new Set();
	const descriptors = [];
	for (const group of descriptorGroups) for (const descriptor of group) {
		if (seen.has(descriptor.name)) continue;
		seen.add(descriptor.name);
		descriptors.push(descriptor);
	}
	return descriptors;
}
function defineCommandDescriptorCatalog(descriptors) {
	return {
		descriptors,
		getDescriptors: () => descriptors,
		getNames: () => getCommandDescriptorNames(descriptors),
		getCommandsWithSubcommands: () => getCommandsWithSubcommands(descriptors)
	};
}
function addCommandDescriptorsToProgram(program, descriptors, existingCommands = /* @__PURE__ */ new Set()) {
	for (const descriptor of descriptors) {
		const name = assertSafeCommandDescriptorName(descriptor.name);
		if (existingCommands.has(name)) continue;
		program.command(name).description(sanitizeCommandDescriptorDescription(descriptor.description));
		existingCommands.add(name);
	}
	return existingCommands;
}
//#endregion
//#region src/cli/program/core-command-descriptors.ts
const coreCliCommandCatalog = defineCommandDescriptorCatalog([
	{
		name: "crestodian",
		description: "Open the ring-zero setup and repair helper",
		hasSubcommands: false
	},
	{
		name: "setup",
		description: "Initialize local config and agent workspace",
		hasSubcommands: false
	},
	{
		name: "onboard",
		description: "Interactive onboarding for gateway, workspace, and skills",
		hasSubcommands: false
	},
	{
		name: "configure",
		description: "Interactive configuration for credentials, channels, gateway, and agent defaults",
		hasSubcommands: false
	},
	{
		name: "config",
		description: "Non-interactive config helpers (get/set/unset/file/validate). Default: starts guided setup.",
		hasSubcommands: true
	},
	{
		name: "backup",
		description: "Create and verify local backup archives for OpenClaw state",
		hasSubcommands: true
	},
	{
		name: "migrate",
		description: "Import state from another agent system",
		hasSubcommands: true
	},
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
	},
	{
		name: "message",
		description: "Send, read, and manage messages",
		hasSubcommands: true
	},
	{
		name: "mcp",
		description: "Manage OpenClaw MCP config and channel bridge",
		hasSubcommands: true
	},
	{
		name: "agent",
		description: "Run one agent turn via the Gateway",
		hasSubcommands: false
	},
	{
		name: "agents",
		description: "Manage isolated agents (workspaces, auth, routing)",
		hasSubcommands: true
	},
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
	},
	{
		name: "commitments",
		description: "List and manage inferred follow-up commitments",
		hasSubcommands: true
	},
	{
		name: "tasks",
		description: "Inspect durable background task state",
		hasSubcommands: true
	}
]);
const CORE_CLI_COMMAND_DESCRIPTORS = coreCliCommandCatalog.descriptors;
function getCoreCliCommandDescriptors() {
	return coreCliCommandCatalog.getDescriptors();
}
function getCoreCliCommandNames() {
	return coreCliCommandCatalog.getNames();
}
function getCoreCliCommandsWithSubcommands() {
	return coreCliCommandCatalog.getCommandsWithSubcommands();
}
//#endregion
//#region src/cli/program/private-qa-cli.ts
const PRIVATE_QA_DIST_RELATIVE_PATH = path.join("dist", "plugin-sdk", "qa-lab.js");
function isPrivateQaCliEnabled(env = process.env) {
	return env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}
function resolvePrivateQaSourceModuleSpecifier(params) {
	if (!isPrivateQaCliEnabled(params?.env ?? process.env)) return null;
	const packageRoot = (params?.resolvePackageRootSync ?? resolveOpenClawPackageRootSync)({
		argv1: params?.argv1 ?? process.argv[1],
		cwd: params?.cwd ?? process.cwd(),
		moduleUrl: params?.moduleUrl ?? import.meta.url
	});
	if (!packageRoot) return null;
	const existsSync = params?.existsSync ?? fs.existsSync;
	const sourceModulePath = path.join(packageRoot, PRIVATE_QA_DIST_RELATIVE_PATH);
	if (!existsSync(path.join(packageRoot, ".git")) || !existsSync(path.join(packageRoot, "src")) || !existsSync(sourceModulePath)) return null;
	return pathToFileURL(sourceModulePath).href;
}
async function dynamicImportPrivateQaCliModule(specifier) {
	return await import(specifier);
}
function loadPrivateQaCliModule(params) {
	const specifier = resolvePrivateQaSourceModuleSpecifier(params);
	if (!specifier) throw new Error("Private QA CLI is only available from an OpenClaw source checkout.");
	return (params?.importModule ?? dynamicImportPrivateQaCliModule)(specifier);
}
//#endregion
//#region src/cli/program/subcli-descriptors.ts
const subCliCommandCatalog = defineCommandDescriptorCatalog([
	{
		name: "acp",
		description: "Agent Control Protocol tools",
		hasSubcommands: true
	},
	{
		name: "gateway",
		description: "Run, inspect, and query the WebSocket Gateway",
		hasSubcommands: true
	},
	{
		name: "daemon",
		description: "Gateway service (legacy alias)",
		hasSubcommands: true
	},
	{
		name: "logs",
		description: "Tail gateway file logs via RPC",
		hasSubcommands: false
	},
	{
		name: "system",
		description: "System events, heartbeat, and presence",
		hasSubcommands: true
	},
	{
		name: "models",
		description: "Discover, scan, and configure models",
		hasSubcommands: true
	},
	{
		name: "infer",
		description: "Run provider-backed inference commands",
		hasSubcommands: true
	},
	{
		name: "capability",
		description: "Run provider-backed inference commands (fallback alias: infer)",
		hasSubcommands: true
	},
	{
		name: "approvals",
		description: "Manage exec approvals (gateway or node host)",
		hasSubcommands: true
	},
	{
		name: "exec-policy",
		description: "Show or synchronize requested exec policy with host approvals",
		hasSubcommands: true
	},
	{
		name: "nodes",
		description: "Manage gateway-owned node pairing and node commands",
		hasSubcommands: true
	},
	{
		name: "devices",
		description: "Device pairing + token management",
		hasSubcommands: true
	},
	{
		name: "node",
		description: "Run and manage the headless node host service",
		hasSubcommands: true
	},
	{
		name: "sandbox",
		description: "Manage sandbox containers for agent isolation",
		hasSubcommands: true
	},
	{
		name: "tui",
		description: "Open a terminal UI connected to the Gateway",
		hasSubcommands: false
	},
	{
		name: "terminal",
		description: "Open a local terminal UI (alias for tui --local)",
		hasSubcommands: false
	},
	{
		name: "chat",
		description: "Open a local terminal UI (alias for tui --local)",
		hasSubcommands: false
	},
	{
		name: "cron",
		description: "Manage cron jobs via the Gateway scheduler",
		hasSubcommands: true
	},
	{
		name: "dns",
		description: "DNS helpers for wide-area discovery (Tailscale + CoreDNS)",
		hasSubcommands: true
	},
	{
		name: "docs",
		description: "Search the live OpenClaw docs",
		hasSubcommands: false
	},
	{
		name: "qa",
		description: "Run QA scenarios and launch the private QA debugger UI",
		hasSubcommands: true
	},
	{
		name: "proxy",
		description: "Run the OpenClaw debug proxy and inspect captured traffic",
		hasSubcommands: true
	},
	{
		name: "hooks",
		description: "Manage internal agent hooks",
		hasSubcommands: true
	},
	{
		name: "webhooks",
		description: "Webhook helpers and integrations",
		hasSubcommands: true
	},
	{
		name: "qr",
		description: "Generate mobile pairing QR/setup code",
		hasSubcommands: false
	},
	{
		name: "clawbot",
		description: "Legacy clawbot command aliases",
		hasSubcommands: true
	},
	{
		name: "pairing",
		description: "Secure DM pairing (approve inbound requests)",
		hasSubcommands: true
	},
	{
		name: "plugins",
		description: "Manage OpenClaw plugins",
		hasSubcommands: true
	},
	{
		name: "channels",
		description: "Manage connected chat channels (Telegram, Discord, etc.)",
		hasSubcommands: true
	},
	{
		name: "directory",
		description: "Lookup contact and group IDs (self, peers, groups) for supported chat channels",
		hasSubcommands: true
	},
	{
		name: "security",
		description: "Security tools and local config audits",
		hasSubcommands: true
	},
	{
		name: "secrets",
		description: "Secrets runtime reload controls",
		hasSubcommands: true
	},
	{
		name: "skills",
		description: "List and inspect available skills",
		hasSubcommands: true
	},
	{
		name: "update",
		description: "Update OpenClaw and inspect update channel status",
		hasSubcommands: true
	},
	{
		name: "completion",
		description: "Generate shell completion script",
		hasSubcommands: false
	}
]);
const SUB_CLI_DESCRIPTORS = subCliCommandCatalog.descriptors;
function getSubCliEntries() {
	const descriptors = subCliCommandCatalog.getDescriptors();
	if (isPrivateQaCliEnabled()) return descriptors;
	return descriptors.filter((descriptor) => descriptor.name !== "qa");
}
function getSubCliCommandsWithSubcommands() {
	const commands = subCliCommandCatalog.getCommandsWithSubcommands();
	if (isPrivateQaCliEnabled()) return commands;
	return commands.filter((command) => command !== "qa");
}
//#endregion
//#region src/cli/argv.ts
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);
const ROOT_VERSION_ALIAS_FLAG = "-v";
const ROOT_COMMAND_DESCRIPTORS = [...CORE_CLI_COMMAND_DESCRIPTORS, ...SUB_CLI_DESCRIPTORS];
const KNOWN_ROOT_COMMANDS = new Set(ROOT_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name));
const ROOT_COMMANDS_WITH_SUBCOMMANDS = new Set(ROOT_COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.hasSubcommands).map((descriptor) => descriptor.name));
function isHelpOrVersionInvocation(argv) {
	if (hasRootVersionAlias(argv)) return true;
	const args = argv.slice(2);
	let sawCommandOption = false;
	const positionals = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg || arg === "--") break;
		const rootConsumed = consumeRootOptionToken(args, i);
		if (rootConsumed > 0) {
			i += rootConsumed - 1;
			continue;
		}
		if (HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg)) return true;
		if (arg.startsWith("-")) {
			sawCommandOption = true;
			continue;
		}
		positionals.push(arg);
		if (arg !== "help") continue;
		if (sawCommandOption) return false;
		if (positionals.length === 1) return true;
		const [primary] = positionals;
		if (!primary || !KNOWN_ROOT_COMMANDS.has(primary)) return true;
		if (positionals.length === 2 && ROOT_COMMANDS_WITH_SUBCOMMANDS.has(primary)) return true;
		return false;
	}
	return false;
}
function parsePositiveInt(value) {
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return;
	return parsed;
}
function hasFlag(argv, name) {
	const args = argv.slice(2);
	for (const arg of args) {
		if (arg === "--") break;
		if (arg === name) return true;
	}
	return false;
}
function hasRootVersionAlias(argv) {
	const args = argv.slice(2);
	let hasAlias = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (arg === ROOT_VERSION_ALIAS_FLAG) {
			hasAlias = true;
			continue;
		}
		const consumed = consumeRootOptionToken(args, i);
		if (consumed > 0) {
			i += consumed - 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return false;
	}
	return hasAlias;
}
function isRootVersionInvocation(argv) {
	return isRootInvocationForFlags(argv, VERSION_FLAGS, { includeVersionAlias: true });
}
function isRootInvocationForFlags(argv, targetFlags, options) {
	const args = argv.slice(2);
	let hasTarget = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (targetFlags.has(arg) || options?.includeVersionAlias === true && arg === ROOT_VERSION_ALIAS_FLAG) {
			hasTarget = true;
			continue;
		}
		const consumed = consumeRootOptionToken(args, i);
		if (consumed > 0) {
			i += consumed - 1;
			continue;
		}
		return false;
	}
	return hasTarget;
}
function isRootHelpInvocation(argv) {
	return isRootInvocationForFlags(argv, HELP_FLAGS);
}
function getFlagValue(argv, name) {
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === name) {
			const next = args[i + 1];
			return isValueToken(next) ? next : null;
		}
		if (arg.startsWith(`${name}=`)) {
			const value = arg.slice(name.length + 1);
			return value ? value : null;
		}
	}
}
function getVerboseFlag(argv, options) {
	if (hasFlag(argv, "--verbose")) return true;
	if (options?.includeDebug && hasFlag(argv, "--debug")) return true;
	return false;
}
function getPositiveIntFlagValue(argv, name) {
	const raw = getFlagValue(argv, name);
	if (raw === null || raw === void 0) return raw;
	return parsePositiveInt(raw);
}
function getCommandPathWithRootOptions(argv, depth = 2) {
	return getCommandPathInternal(argv, depth, { skipRootOptions: true });
}
function getCommandPathInternal(argv, depth, opts) {
	const args = argv.slice(2);
	const path = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (opts.skipRootOptions) {
			const consumed = consumeRootOptionToken(args, i);
			if (consumed > 0) {
				i += consumed - 1;
				continue;
			}
		}
		if (arg.startsWith("-")) continue;
		path.push(arg);
		if (path.length >= depth) break;
	}
	return path;
}
function getPrimaryCommand(argv) {
	const [primary] = getCommandPathWithRootOptions(argv, 1);
	return primary ?? null;
}
function consumeKnownOptionToken(args, index, booleanFlags, valueFlags) {
	const arg = args[index];
	if (!arg || arg === "--" || !arg.startsWith("-")) return 0;
	const equalsIndex = arg.indexOf("=");
	const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
	if (booleanFlags.has(flag)) return equalsIndex === -1 ? 1 : 0;
	if (!valueFlags.has(flag)) return 0;
	if (equalsIndex !== -1) return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
	return isValueToken(args[index + 1]) ? 2 : 0;
}
function getCommandPositionalsWithRootOptions(argv, options) {
	const args = argv.slice(2);
	const commandPath = options.commandPath;
	const booleanFlags = new Set(options.booleanFlags ?? []);
	const valueFlags = new Set(options.valueFlags ?? []);
	const positionals = [];
	let commandIndex = 0;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg || arg === "--") break;
		const rootConsumed = consumeRootOptionToken(args, i);
		if (rootConsumed > 0) {
			i += rootConsumed - 1;
			continue;
		}
		if (arg.startsWith("-")) {
			const optionConsumed = consumeKnownOptionToken(args, i, booleanFlags, valueFlags);
			if (optionConsumed === 0) return null;
			i += optionConsumed - 1;
			continue;
		}
		if (commandIndex < commandPath.length) {
			if (arg !== commandPath[commandIndex]) return null;
			commandIndex += 1;
			continue;
		}
		positionals.push(arg);
	}
	if (commandIndex < commandPath.length) return null;
	return positionals;
}
function buildParseArgv(params) {
	const baseArgv = params.rawArgs && params.rawArgs.length > 0 ? params.rawArgs : params.fallbackArgv && params.fallbackArgv.length > 0 ? params.fallbackArgv : process.argv;
	const programName = params.programName ?? "";
	const normalizedArgv = programName && baseArgv[0] === programName ? baseArgv.slice(1) : baseArgv[0]?.endsWith("openclaw") ? baseArgv.slice(1) : baseArgv;
	if (normalizedArgv.length >= 2 && (isNodeRuntime(normalizedArgv[0] ?? "") || isBunRuntime(normalizedArgv[0] ?? ""))) return normalizedArgv;
	return [
		"node",
		programName || "openclaw",
		...normalizedArgv
	];
}
function shouldMigrateStateFromPath(path) {
	if (path.length === 0) return true;
	const [primary, secondary] = path;
	if (primary === "health" || primary === "status" || primary === "sessions") return false;
	if (primary === "update" && secondary === "status") return false;
	if (primary === "config" && (secondary === "get" || secondary === "unset")) return false;
	if (primary === "models" && (secondary === "list" || secondary === "status")) return false;
	if (primary === "agent") return false;
	return true;
}
//#endregion
export { sanitizeCommandDescriptorDescription as C, isNodeRuntime as D, isBunRuntime as E, normalizeCommandDescriptorName as S, isValueToken as T, getCoreCliCommandDescriptors as _, getPositiveIntFlagValue as a, addCommandDescriptorsToProgram as b, hasFlag as c, isRootHelpInvocation as d, isRootVersionInvocation as f, loadPrivateQaCliModule as g, getSubCliEntries as h, getFlagValue as i, hasRootVersionAlias as l, getSubCliCommandsWithSubcommands as m, getCommandPathWithRootOptions as n, getPrimaryCommand as o, shouldMigrateStateFromPath as p, getCommandPositionalsWithRootOptions as r, getVerboseFlag as s, buildParseArgv as t, isHelpOrVersionInvocation as u, getCoreCliCommandNames as v, consumeRootOptionToken as w, collectUniqueCommandDescriptors as x, getCoreCliCommandsWithSubcommands as y };
