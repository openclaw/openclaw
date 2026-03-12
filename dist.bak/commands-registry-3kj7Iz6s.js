import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { M as getActivePluginRegistry, Z as escapeRegExp } from "./entry.js";
import { $r as DEFAULT_PROVIDER, Gn as resolveConfiguredModelRef, Qr as DEFAULT_MODEL } from "./auth-profiles-D6H-HVV8.js";
import { n as listChannelDocks } from "./dock-B6idJaIX.js";
import { i as listThinkingLevels } from "./thinking-DW6CKWyf.js";
import { t as isCommandFlagEnabled } from "./commands-CQRE0cc7.js";

//#region src/auto-reply/commands-args.ts
function normalizeArgValue(value) {
	if (value == null) return;
	let text;
	if (typeof value === "string") text = value.trim();
	else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") text = String(value).trim();
	else if (typeof value === "symbol") text = value.toString().trim();
	else if (typeof value === "function") text = value.toString().trim();
	else text = JSON.stringify(value);
	return text ? text : void 0;
}
function formatActionArgs(values, params) {
	const action = normalizeArgValue(values.action)?.toLowerCase();
	const path = normalizeArgValue(values.path);
	const value = normalizeArgValue(values.value);
	if (!action) return;
	const knownAction = params.formatKnownAction(action, path);
	if (knownAction) return knownAction;
	return formatSetUnsetArgAction(action, {
		path,
		value
	});
}
const formatConfigArgs = (values) => formatActionArgs(values, { formatKnownAction: (action, path) => {
	if (action === "show" || action === "get") return path ? `${action} ${path}` : action;
} });
const formatDebugArgs = (values) => formatActionArgs(values, { formatKnownAction: (action) => {
	if (action === "show" || action === "reset") return action;
} });
function formatSetUnsetArgAction(action, params) {
	if (action === "unset") return params.path ? `${action} ${params.path}` : action;
	if (action === "set") {
		if (!params.path) return action;
		if (!params.value) return `${action} ${params.path}`;
		return `${action} ${params.path}=${params.value}`;
	}
	return action;
}
const formatQueueArgs = (values) => {
	const mode = normalizeArgValue(values.mode);
	const debounce = normalizeArgValue(values.debounce);
	const cap = normalizeArgValue(values.cap);
	const drop = normalizeArgValue(values.drop);
	const parts = [];
	if (mode) parts.push(mode);
	if (debounce) parts.push(`debounce:${debounce}`);
	if (cap) parts.push(`cap:${cap}`);
	if (drop) parts.push(`drop:${drop}`);
	return parts.length > 0 ? parts.join(" ") : void 0;
};
const formatExecArgs = (values) => {
	const host = normalizeArgValue(values.host);
	const security = normalizeArgValue(values.security);
	const ask = normalizeArgValue(values.ask);
	const node = normalizeArgValue(values.node);
	const parts = [];
	if (host) parts.push(`host=${host}`);
	if (security) parts.push(`security=${security}`);
	if (ask) parts.push(`ask=${ask}`);
	if (node) parts.push(`node=${node}`);
	return parts.length > 0 ? parts.join(" ") : void 0;
};
const COMMAND_ARG_FORMATTERS = {
	config: formatConfigArgs,
	debug: formatDebugArgs,
	queue: formatQueueArgs,
	exec: formatExecArgs
};

//#endregion
//#region src/auto-reply/commands-registry.data.ts
function defineChatCommand(command) {
	const aliases = (command.textAliases ?? (command.textAlias ? [command.textAlias] : [])).map((alias) => alias.trim()).filter(Boolean);
	const scope = command.scope ?? (command.nativeName ? aliases.length ? "both" : "native" : "text");
	const acceptsArgs = command.acceptsArgs ?? Boolean(command.args?.length);
	const argsParsing = command.argsParsing ?? (command.args?.length ? "positional" : "none");
	return {
		key: command.key,
		nativeName: command.nativeName,
		description: command.description,
		acceptsArgs,
		args: command.args,
		argsParsing,
		formatArgs: command.formatArgs,
		argsMenu: command.argsMenu,
		textAliases: aliases,
		scope,
		category: command.category
	};
}
function defineDockCommand(dock) {
	return defineChatCommand({
		key: `dock:${dock.id}`,
		nativeName: `dock_${dock.id}`,
		description: `Switch to ${dock.id} for replies.`,
		textAliases: [`/dock-${dock.id}`, `/dock_${dock.id}`],
		category: "docks"
	});
}
function registerAlias(commands, key, ...aliases) {
	const command = commands.find((entry) => entry.key === key);
	if (!command) throw new Error(`registerAlias: unknown command key: ${key}`);
	const existing = new Set(command.textAliases.map((alias) => alias.trim().toLowerCase()));
	for (const alias of aliases) {
		const trimmed = alias.trim();
		if (!trimmed) continue;
		const lowered = trimmed.toLowerCase();
		if (existing.has(lowered)) continue;
		existing.add(lowered);
		command.textAliases.push(trimmed);
	}
}
function assertCommandRegistry(commands) {
	const keys = /* @__PURE__ */ new Set();
	const nativeNames = /* @__PURE__ */ new Set();
	const textAliases = /* @__PURE__ */ new Set();
	for (const command of commands) {
		if (keys.has(command.key)) throw new Error(`Duplicate command key: ${command.key}`);
		keys.add(command.key);
		const nativeName = command.nativeName?.trim();
		if (command.scope === "text") {
			if (nativeName) throw new Error(`Text-only command has native name: ${command.key}`);
			if (command.textAliases.length === 0) throw new Error(`Text-only command missing text alias: ${command.key}`);
		} else if (!nativeName) throw new Error(`Native command missing native name: ${command.key}`);
		else {
			const nativeKey = nativeName.toLowerCase();
			if (nativeNames.has(nativeKey)) throw new Error(`Duplicate native command: ${nativeName}`);
			nativeNames.add(nativeKey);
		}
		if (command.scope === "native" && command.textAliases.length > 0) throw new Error(`Native-only command has text aliases: ${command.key}`);
		for (const alias of command.textAliases) {
			if (!alias.startsWith("/")) throw new Error(`Command alias missing leading '/': ${alias}`);
			const aliasKey = alias.toLowerCase();
			if (textAliases.has(aliasKey)) throw new Error(`Duplicate command alias: ${alias}`);
			textAliases.add(aliasKey);
		}
	}
}
let cachedCommands = null;
let cachedRegistry = null;
let cachedNativeCommandSurfaces = null;
let cachedNativeRegistry = null;
function buildChatCommands() {
	const commands = [
		defineChatCommand({
			key: "help",
			nativeName: "help",
			description: "Show available commands.",
			textAlias: "/help",
			category: "status"
		}),
		defineChatCommand({
			key: "commands",
			nativeName: "commands",
			description: "List all slash commands.",
			textAlias: "/commands",
			category: "status"
		}),
		defineChatCommand({
			key: "skill",
			nativeName: "skill",
			description: "Run a skill by name.",
			textAlias: "/skill",
			category: "tools",
			args: [{
				name: "name",
				description: "Skill name",
				type: "string",
				required: true
			}, {
				name: "input",
				description: "Skill input",
				type: "string",
				captureRemaining: true
			}]
		}),
		defineChatCommand({
			key: "status",
			nativeName: "status",
			description: "Show current status.",
			textAlias: "/status",
			category: "status"
		}),
		defineChatCommand({
			key: "allowlist",
			description: "List/add/remove allowlist entries.",
			textAlias: "/allowlist",
			acceptsArgs: true,
			scope: "text",
			category: "management"
		}),
		defineChatCommand({
			key: "approve",
			nativeName: "approve",
			description: "Approve or deny exec requests.",
			textAlias: "/approve",
			acceptsArgs: true,
			category: "management"
		}),
		defineChatCommand({
			key: "context",
			nativeName: "context",
			description: "Explain how context is built and used.",
			textAlias: "/context",
			acceptsArgs: true,
			category: "status"
		}),
		defineChatCommand({
			key: "export-session",
			nativeName: "export-session",
			description: "Export current session to HTML file with full system prompt.",
			textAliases: ["/export-session", "/export"],
			acceptsArgs: true,
			category: "status",
			args: [{
				name: "path",
				description: "Output path (default: workspace)",
				type: "string",
				required: false
			}]
		}),
		defineChatCommand({
			key: "tts",
			nativeName: "tts",
			description: "Control text-to-speech (TTS).",
			textAlias: "/tts",
			category: "media",
			args: [{
				name: "action",
				description: "TTS action",
				type: "string",
				choices: [
					{
						value: "on",
						label: "On"
					},
					{
						value: "off",
						label: "Off"
					},
					{
						value: "status",
						label: "Status"
					},
					{
						value: "provider",
						label: "Provider"
					},
					{
						value: "limit",
						label: "Limit"
					},
					{
						value: "summary",
						label: "Summary"
					},
					{
						value: "audio",
						label: "Audio"
					},
					{
						value: "help",
						label: "Help"
					}
				]
			}, {
				name: "value",
				description: "Provider, limit, or text",
				type: "string",
				captureRemaining: true
			}],
			argsMenu: {
				arg: "action",
				title: "TTS Actions:\n• On – Enable TTS for responses\n• Off – Disable TTS\n• Status – Show current settings\n• Provider – Set voice provider (edge, elevenlabs, openai)\n• Limit – Set max characters for TTS\n• Summary – Toggle AI summary for long texts\n• Audio – Generate TTS from custom text\n• Help – Show usage guide"
			}
		}),
		defineChatCommand({
			key: "whoami",
			nativeName: "whoami",
			description: "Show your sender id.",
			textAlias: "/whoami",
			category: "status"
		}),
		defineChatCommand({
			key: "session",
			nativeName: "session",
			description: "Manage session-level settings (for example /session idle).",
			textAlias: "/session",
			category: "session",
			args: [{
				name: "action",
				description: "idle | max-age",
				type: "string",
				choices: ["idle", "max-age"]
			}, {
				name: "value",
				description: "Duration (24h, 90m) or off",
				type: "string",
				captureRemaining: true
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "subagents",
			nativeName: "subagents",
			description: "List, kill, log, spawn, or steer subagent runs for this session.",
			textAlias: "/subagents",
			category: "management",
			args: [
				{
					name: "action",
					description: "list | kill | log | info | send | steer | spawn",
					type: "string",
					choices: [
						"list",
						"kill",
						"log",
						"info",
						"send",
						"steer",
						"spawn"
					]
				},
				{
					name: "target",
					description: "Run id, index, or session key",
					type: "string"
				},
				{
					name: "value",
					description: "Additional input (limit/message)",
					type: "string",
					captureRemaining: true
				}
			],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "acp",
			nativeName: "acp",
			description: "Manage ACP sessions and runtime options.",
			textAlias: "/acp",
			category: "management",
			args: [{
				name: "action",
				description: "Action to run",
				type: "string",
				choices: [
					"spawn",
					"cancel",
					"steer",
					"close",
					"sessions",
					"status",
					"set-mode",
					"set",
					"cwd",
					"permissions",
					"timeout",
					"model",
					"reset-options",
					"doctor",
					"install",
					"help"
				]
			}, {
				name: "value",
				description: "Action arguments",
				type: "string",
				captureRemaining: true
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "focus",
			nativeName: "focus",
			description: "Bind this Discord thread (or a new one) to a session target.",
			textAlias: "/focus",
			category: "management",
			args: [{
				name: "target",
				description: "Subagent label/index or session key/id/label",
				type: "string",
				captureRemaining: true
			}]
		}),
		defineChatCommand({
			key: "unfocus",
			nativeName: "unfocus",
			description: "Remove the current Discord thread binding.",
			textAlias: "/unfocus",
			category: "management"
		}),
		defineChatCommand({
			key: "agents",
			nativeName: "agents",
			description: "List thread-bound agents for this session.",
			textAlias: "/agents",
			category: "management"
		}),
		defineChatCommand({
			key: "kill",
			nativeName: "kill",
			description: "Kill a running subagent (or all).",
			textAlias: "/kill",
			category: "management",
			args: [{
				name: "target",
				description: "Label, run id, index, or all",
				type: "string"
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "steer",
			nativeName: "steer",
			description: "Send guidance to a running subagent.",
			textAlias: "/steer",
			category: "management",
			args: [{
				name: "target",
				description: "Label, run id, or index",
				type: "string"
			}, {
				name: "message",
				description: "Steering message",
				type: "string",
				captureRemaining: true
			}]
		}),
		defineChatCommand({
			key: "config",
			nativeName: "config",
			description: "Show or set config values.",
			textAlias: "/config",
			category: "management",
			args: [
				{
					name: "action",
					description: "show | get | set | unset",
					type: "string",
					choices: [
						"show",
						"get",
						"set",
						"unset"
					]
				},
				{
					name: "path",
					description: "Config path",
					type: "string"
				},
				{
					name: "value",
					description: "Value for set",
					type: "string",
					captureRemaining: true
				}
			],
			argsParsing: "none",
			formatArgs: COMMAND_ARG_FORMATTERS.config
		}),
		defineChatCommand({
			key: "debug",
			nativeName: "debug",
			description: "Set runtime debug overrides.",
			textAlias: "/debug",
			category: "management",
			args: [
				{
					name: "action",
					description: "show | reset | set | unset",
					type: "string",
					choices: [
						"show",
						"reset",
						"set",
						"unset"
					]
				},
				{
					name: "path",
					description: "Debug path",
					type: "string"
				},
				{
					name: "value",
					description: "Value for set",
					type: "string",
					captureRemaining: true
				}
			],
			argsParsing: "none",
			formatArgs: COMMAND_ARG_FORMATTERS.debug
		}),
		defineChatCommand({
			key: "usage",
			nativeName: "usage",
			description: "Usage footer or cost summary.",
			textAlias: "/usage",
			category: "options",
			args: [{
				name: "mode",
				description: "off, tokens, full, or cost",
				type: "string",
				choices: [
					"off",
					"tokens",
					"full",
					"cost"
				]
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "stop",
			nativeName: "stop",
			description: "Stop the current run.",
			textAlias: "/stop",
			category: "session"
		}),
		defineChatCommand({
			key: "restart",
			nativeName: "restart",
			description: "Restart OpenClaw.",
			textAlias: "/restart",
			category: "tools"
		}),
		defineChatCommand({
			key: "activation",
			nativeName: "activation",
			description: "Set group activation mode.",
			textAlias: "/activation",
			category: "management",
			args: [{
				name: "mode",
				description: "mention or always",
				type: "string",
				choices: ["mention", "always"]
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "send",
			nativeName: "send",
			description: "Set send policy.",
			textAlias: "/send",
			category: "management",
			args: [{
				name: "mode",
				description: "on, off, or inherit",
				type: "string",
				choices: [
					"on",
					"off",
					"inherit"
				]
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "reset",
			nativeName: "reset",
			description: "Reset the current session.",
			textAlias: "/reset",
			acceptsArgs: true,
			category: "session"
		}),
		defineChatCommand({
			key: "new",
			nativeName: "new",
			description: "Start a new session.",
			textAlias: "/new",
			acceptsArgs: true,
			category: "session"
		}),
		defineChatCommand({
			key: "compact",
			nativeName: "compact",
			description: "Compact the session context.",
			textAlias: "/compact",
			category: "session",
			args: [{
				name: "instructions",
				description: "Extra compaction instructions",
				type: "string",
				captureRemaining: true
			}]
		}),
		defineChatCommand({
			key: "think",
			nativeName: "think",
			description: "Set thinking level.",
			textAlias: "/think",
			category: "options",
			args: [{
				name: "level",
				description: "off, minimal, low, medium, high, xhigh",
				type: "string",
				choices: ({ provider, model }) => listThinkingLevels(provider, model)
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "verbose",
			nativeName: "verbose",
			description: "Toggle verbose mode.",
			textAlias: "/verbose",
			category: "options",
			args: [{
				name: "mode",
				description: "on or off",
				type: "string",
				choices: ["on", "off"]
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "reasoning",
			nativeName: "reasoning",
			description: "Toggle reasoning visibility.",
			textAlias: "/reasoning",
			category: "options",
			args: [{
				name: "mode",
				description: "on, off, or stream",
				type: "string",
				choices: [
					"on",
					"off",
					"stream"
				]
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "elevated",
			nativeName: "elevated",
			description: "Toggle elevated mode.",
			textAlias: "/elevated",
			category: "options",
			args: [{
				name: "mode",
				description: "on, off, ask, or full",
				type: "string",
				choices: [
					"on",
					"off",
					"ask",
					"full"
				]
			}],
			argsMenu: "auto"
		}),
		defineChatCommand({
			key: "exec",
			nativeName: "exec",
			description: "Set exec defaults for this session.",
			textAlias: "/exec",
			category: "options",
			args: [
				{
					name: "host",
					description: "sandbox, gateway, or node",
					type: "string",
					choices: [
						"sandbox",
						"gateway",
						"node"
					]
				},
				{
					name: "security",
					description: "deny, allowlist, or full",
					type: "string",
					choices: [
						"deny",
						"allowlist",
						"full"
					]
				},
				{
					name: "ask",
					description: "off, on-miss, or always",
					type: "string",
					choices: [
						"off",
						"on-miss",
						"always"
					]
				},
				{
					name: "node",
					description: "Node id or name",
					type: "string"
				}
			],
			argsParsing: "none",
			formatArgs: COMMAND_ARG_FORMATTERS.exec
		}),
		defineChatCommand({
			key: "model",
			nativeName: "model",
			description: "Show or set the model.",
			textAlias: "/model",
			category: "options",
			args: [{
				name: "model",
				description: "Model id (provider/model or id)",
				type: "string"
			}]
		}),
		defineChatCommand({
			key: "models",
			nativeName: "models",
			description: "List model providers or provider models.",
			textAlias: "/models",
			argsParsing: "none",
			acceptsArgs: true,
			category: "options"
		}),
		defineChatCommand({
			key: "queue",
			nativeName: "queue",
			description: "Adjust queue settings.",
			textAlias: "/queue",
			category: "options",
			args: [
				{
					name: "mode",
					description: "queue mode",
					type: "string",
					choices: [
						"steer",
						"interrupt",
						"followup",
						"collect",
						"steer-backlog"
					]
				},
				{
					name: "debounce",
					description: "debounce duration (e.g. 500ms, 2s)",
					type: "string"
				},
				{
					name: "cap",
					description: "queue cap",
					type: "number"
				},
				{
					name: "drop",
					description: "drop policy",
					type: "string",
					choices: [
						"old",
						"new",
						"summarize"
					]
				}
			],
			argsParsing: "none",
			formatArgs: COMMAND_ARG_FORMATTERS.queue
		}),
		defineChatCommand({
			key: "bash",
			description: "Run host shell commands (host-only).",
			textAlias: "/bash",
			scope: "text",
			category: "tools",
			args: [{
				name: "command",
				description: "Shell command",
				type: "string",
				captureRemaining: true
			}]
		}),
		...listChannelDocks().filter((dock) => dock.capabilities.nativeCommands).map((dock) => defineDockCommand(dock))
	];
	registerAlias(commands, "whoami", "/id");
	registerAlias(commands, "think", "/thinking", "/t");
	registerAlias(commands, "verbose", "/v");
	registerAlias(commands, "reasoning", "/reason");
	registerAlias(commands, "elevated", "/elev");
	registerAlias(commands, "steer", "/tell");
	assertCommandRegistry(commands);
	return commands;
}
function getChatCommands() {
	const registry = getActivePluginRegistry();
	if (cachedCommands && registry === cachedRegistry) return cachedCommands;
	const commands = buildChatCommands();
	cachedCommands = commands;
	cachedRegistry = registry;
	cachedNativeCommandSurfaces = null;
	return commands;
}
function getNativeCommandSurfaces() {
	const registry = getActivePluginRegistry();
	if (cachedNativeCommandSurfaces && registry === cachedNativeRegistry) return cachedNativeCommandSurfaces;
	cachedNativeCommandSurfaces = new Set(listChannelDocks().filter((dock) => dock.capabilities.nativeCommands).map((dock) => dock.id));
	cachedNativeRegistry = registry;
	return cachedNativeCommandSurfaces;
}

//#endregion
//#region src/auto-reply/commands-registry.ts
var commands_registry_exports = /* @__PURE__ */ __exportAll({
	buildCommandText: () => buildCommandText,
	buildCommandTextFromArgs: () => buildCommandTextFromArgs,
	findCommandByNativeName: () => findCommandByNativeName,
	getCommandDetection: () => getCommandDetection,
	isCommandEnabled: () => isCommandEnabled,
	isCommandMessage: () => isCommandMessage,
	isNativeCommandSurface: () => isNativeCommandSurface,
	listChatCommands: () => listChatCommands,
	listChatCommandsForConfig: () => listChatCommandsForConfig,
	listNativeCommandSpecs: () => listNativeCommandSpecs,
	listNativeCommandSpecsForConfig: () => listNativeCommandSpecsForConfig,
	maybeResolveTextAlias: () => maybeResolveTextAlias,
	normalizeCommandBody: () => normalizeCommandBody,
	parseCommandArgs: () => parseCommandArgs,
	resolveCommandArgChoices: () => resolveCommandArgChoices,
	resolveCommandArgMenu: () => resolveCommandArgMenu,
	resolveTextCommand: () => resolveTextCommand,
	serializeCommandArgs: () => serializeCommandArgs,
	shouldHandleTextCommands: () => shouldHandleTextCommands
});
let cachedTextAliasMap = null;
let cachedTextAliasCommands = null;
let cachedDetection;
let cachedDetectionCommands = null;
function getTextAliasMap() {
	const commands = getChatCommands();
	if (cachedTextAliasMap && cachedTextAliasCommands === commands) return cachedTextAliasMap;
	const map = /* @__PURE__ */ new Map();
	for (const command of commands) {
		const canonical = command.textAliases[0]?.trim() || `/${command.key}`;
		const acceptsArgs = Boolean(command.acceptsArgs);
		for (const alias of command.textAliases) {
			const normalized = alias.trim().toLowerCase();
			if (!normalized) continue;
			if (!map.has(normalized)) map.set(normalized, {
				key: command.key,
				canonical,
				acceptsArgs
			});
		}
	}
	cachedTextAliasMap = map;
	cachedTextAliasCommands = commands;
	return map;
}
function buildSkillCommandDefinitions(skillCommands) {
	if (!skillCommands || skillCommands.length === 0) return [];
	return skillCommands.map((spec) => ({
		key: `skill:${spec.skillName}`,
		nativeName: spec.name,
		description: spec.description,
		textAliases: [`/${spec.name}`],
		acceptsArgs: true,
		argsParsing: "none",
		scope: "both"
	}));
}
function listChatCommands(params) {
	const commands = getChatCommands();
	if (!params?.skillCommands?.length) return [...commands];
	return [...commands, ...buildSkillCommandDefinitions(params.skillCommands)];
}
function isCommandEnabled(cfg, commandKey) {
	if (commandKey === "config") return isCommandFlagEnabled(cfg, "config");
	if (commandKey === "debug") return isCommandFlagEnabled(cfg, "debug");
	if (commandKey === "bash") return isCommandFlagEnabled(cfg, "bash");
	return true;
}
function listChatCommandsForConfig(cfg, params) {
	const base = getChatCommands().filter((command) => isCommandEnabled(cfg, command.key));
	if (!params?.skillCommands?.length) return base;
	return [...base, ...buildSkillCommandDefinitions(params.skillCommands)];
}
const NATIVE_NAME_OVERRIDES = {
	discord: { tts: "voice" },
	slack: { status: "agentstatus" }
};
function resolveNativeName(command, provider) {
	if (!command.nativeName) return;
	if (provider) {
		const override = NATIVE_NAME_OVERRIDES[provider]?.[command.key];
		if (override) return override;
	}
	return command.nativeName;
}
function toNativeCommandSpec(command, provider) {
	return {
		name: resolveNativeName(command, provider) ?? command.key,
		description: command.description,
		acceptsArgs: Boolean(command.acceptsArgs),
		args: command.args
	};
}
function listNativeSpecsFromCommands(commands, provider) {
	return commands.filter((command) => command.scope !== "text" && command.nativeName).map((command) => toNativeCommandSpec(command, provider));
}
function listNativeCommandSpecs(params) {
	return listNativeSpecsFromCommands(listChatCommands({ skillCommands: params?.skillCommands }), params?.provider);
}
function listNativeCommandSpecsForConfig(cfg, params) {
	return listNativeSpecsFromCommands(listChatCommandsForConfig(cfg, params), params?.provider);
}
function findCommandByNativeName(name, provider) {
	const normalized = name.trim().toLowerCase();
	return getChatCommands().find((command) => command.scope !== "text" && resolveNativeName(command, provider)?.toLowerCase() === normalized);
}
function buildCommandText(commandName, args) {
	const trimmedArgs = args?.trim();
	return trimmedArgs ? `/${commandName} ${trimmedArgs}` : `/${commandName}`;
}
function parsePositionalArgs(definitions, raw) {
	const values = {};
	const trimmed = raw.trim();
	if (!trimmed) return values;
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	let index = 0;
	for (const definition of definitions) {
		if (index >= tokens.length) break;
		if (definition.captureRemaining) {
			values[definition.name] = tokens.slice(index).join(" ");
			index = tokens.length;
			break;
		}
		values[definition.name] = tokens[index];
		index += 1;
	}
	return values;
}
function formatPositionalArgs(definitions, values) {
	const parts = [];
	for (const definition of definitions) {
		const value = values[definition.name];
		if (value == null) continue;
		let rendered;
		if (typeof value === "string") rendered = value.trim();
		else rendered = String(value);
		if (!rendered) continue;
		parts.push(rendered);
		if (definition.captureRemaining) break;
	}
	return parts.length > 0 ? parts.join(" ") : void 0;
}
function parseCommandArgs(command, raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return;
	if (!command.args || command.argsParsing === "none") return { raw: trimmed };
	return {
		raw: trimmed,
		values: parsePositionalArgs(command.args, trimmed)
	};
}
function serializeCommandArgs(command, args) {
	if (!args) return;
	const raw = args.raw?.trim();
	if (raw) return raw;
	if (!args.values || !command.args) return;
	if (command.formatArgs) return command.formatArgs(args.values);
	return formatPositionalArgs(command.args, args.values);
}
function buildCommandTextFromArgs(command, args) {
	return buildCommandText(command.nativeName ?? command.key, serializeCommandArgs(command, args));
}
function resolveDefaultCommandContext(cfg) {
	const resolved = resolveConfiguredModelRef({
		cfg: cfg ?? {},
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	return {
		provider: resolved.provider ?? DEFAULT_PROVIDER,
		model: resolved.model ?? DEFAULT_MODEL
	};
}
function resolveCommandArgChoices(params) {
	const { command, arg, cfg } = params;
	if (!arg.choices) return [];
	const provided = arg.choices;
	return (Array.isArray(provided) ? provided : (() => {
		const defaults = resolveDefaultCommandContext(cfg);
		return provided({
			cfg,
			provider: params.provider ?? defaults.provider,
			model: params.model ?? defaults.model,
			command,
			arg
		});
	})()).map((choice) => typeof choice === "string" ? {
		value: choice,
		label: choice
	} : choice);
}
function resolveCommandArgMenu(params) {
	const { command, args, cfg } = params;
	if (!command.args || !command.argsMenu) return null;
	if (command.argsParsing === "none") return null;
	const argSpec = command.argsMenu;
	const argName = argSpec === "auto" ? command.args.find((arg) => resolveCommandArgChoices({
		command,
		arg,
		cfg
	}).length > 0)?.name : argSpec.arg;
	if (!argName) return null;
	if (args?.values && args.values[argName] != null) return null;
	if (args?.raw && !args.values) return null;
	const arg = command.args.find((entry) => entry.name === argName);
	if (!arg) return null;
	const choices = resolveCommandArgChoices({
		command,
		arg,
		cfg
	});
	if (choices.length === 0) return null;
	return {
		arg,
		choices,
		title: argSpec !== "auto" ? argSpec.title : void 0
	};
}
function normalizeCommandBody(raw, options) {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("/")) return trimmed;
	const newline = trimmed.indexOf("\n");
	const singleLine = newline === -1 ? trimmed : trimmed.slice(0, newline).trim();
	const colonMatch = singleLine.match(/^\/([^\s:]+)\s*:(.*)$/);
	const normalized = colonMatch ? (() => {
		const [, command, rest] = colonMatch;
		const normalizedRest = rest.trimStart();
		return normalizedRest ? `/${command} ${normalizedRest}` : `/${command}`;
	})() : singleLine;
	const normalizedBotUsername = options?.botUsername?.trim().toLowerCase();
	const mentionMatch = normalizedBotUsername ? normalized.match(/^\/([^\s@]+)@([^\s]+)(.*)$/) : null;
	const commandBody = mentionMatch && mentionMatch[2].toLowerCase() === normalizedBotUsername ? `/${mentionMatch[1]}${mentionMatch[3] ?? ""}` : normalized;
	const lowered = commandBody.toLowerCase();
	const textAliasMap = getTextAliasMap();
	const exact = textAliasMap.get(lowered);
	if (exact) return exact.canonical;
	const tokenMatch = commandBody.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
	if (!tokenMatch) return commandBody;
	const [, token, rest] = tokenMatch;
	const tokenKey = `/${token.toLowerCase()}`;
	const tokenSpec = textAliasMap.get(tokenKey);
	if (!tokenSpec) return commandBody;
	if (rest && !tokenSpec.acceptsArgs) return commandBody;
	const normalizedRest = rest?.trimStart();
	return normalizedRest ? `${tokenSpec.canonical} ${normalizedRest}` : tokenSpec.canonical;
}
function isCommandMessage(raw) {
	return normalizeCommandBody(raw).startsWith("/");
}
function getCommandDetection(_cfg) {
	const commands = getChatCommands();
	if (cachedDetection && cachedDetectionCommands === commands) return cachedDetection;
	const exact = /* @__PURE__ */ new Set();
	const patterns = [];
	for (const cmd of commands) for (const alias of cmd.textAliases) {
		const normalized = alias.trim().toLowerCase();
		if (!normalized) continue;
		exact.add(normalized);
		const escaped = escapeRegExp(normalized);
		if (!escaped) continue;
		if (cmd.acceptsArgs) patterns.push(`${escaped}(?:\\s+.+|\\s*:\\s*.*)?`);
		else patterns.push(`${escaped}(?:\\s*:\\s*)?`);
	}
	cachedDetection = {
		exact,
		regex: patterns.length ? new RegExp(`^(?:${patterns.join("|")})$`, "i") : /$^/
	};
	cachedDetectionCommands = commands;
	return cachedDetection;
}
function maybeResolveTextAlias(raw, cfg) {
	const trimmed = normalizeCommandBody(raw).trim();
	if (!trimmed.startsWith("/")) return null;
	const detection = getCommandDetection(cfg);
	const normalized = trimmed.toLowerCase();
	if (detection.exact.has(normalized)) return normalized;
	if (!detection.regex.test(normalized)) return null;
	const tokenMatch = normalized.match(/^\/([^\s:]+)(?:\s|$)/);
	if (!tokenMatch) return null;
	const tokenKey = `/${tokenMatch[1]}`;
	return getTextAliasMap().has(tokenKey) ? tokenKey : null;
}
function resolveTextCommand(raw, cfg) {
	const trimmed = normalizeCommandBody(raw).trim();
	const alias = maybeResolveTextAlias(trimmed, cfg);
	if (!alias) return null;
	const spec = getTextAliasMap().get(alias);
	if (!spec) return null;
	const command = getChatCommands().find((entry) => entry.key === spec.key);
	if (!command) return null;
	if (!spec.acceptsArgs) return { command };
	return {
		command,
		args: trimmed.slice(alias.length).trim() || void 0
	};
}
function isNativeCommandSurface(surface) {
	if (!surface) return false;
	return getNativeCommandSurfaces().has(surface.toLowerCase());
}
function shouldHandleTextCommands(params) {
	if (params.commandSource === "native") return true;
	if (params.cfg.commands?.text !== false) return true;
	return !isNativeCommandSurface(params.surface);
}

//#endregion
export { listChatCommands as a, listNativeCommandSpecsForConfig as c, parseCommandArgs as d, resolveCommandArgChoices as f, shouldHandleTextCommands as h, isCommandEnabled as i, maybeResolveTextAlias as l, serializeCommandArgs as m, commands_registry_exports as n, listChatCommandsForConfig as o, resolveCommandArgMenu as p, findCommandByNativeName as r, listNativeCommandSpecs as s, buildCommandTextFromArgs as t, normalizeCommandBody as u };