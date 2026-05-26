import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { n as resolveGlobalSingleton } from "./global-singleton-B2nbp4Tq.js";
import { r as logVerbose } from "./globals-CouSpJO4.js";
import { s as isOperatorScope } from "./operator-scopes-CpnZaPqz.js";
import { n as resolveGlobalDedupeCache } from "./dedupe-Cby1DfpJ.js";
//#region src/plugins/command-registry-state.ts
const PLUGIN_COMMAND_STATE_KEY = Symbol.for("openclaw.pluginCommandsState");
const getState$1 = () => resolveGlobalSingleton(PLUGIN_COMMAND_STATE_KEY, () => ({
	pluginCommands: /* @__PURE__ */ new Map(),
	registryLocked: false
}));
const getPluginCommandMap = () => getState$1().pluginCommands;
const pluginCommands = new Proxy(/* @__PURE__ */ new Map(), { get(_target, property) {
	const value = Reflect.get(getPluginCommandMap(), property, getPluginCommandMap());
	return typeof value === "function" ? value.bind(getPluginCommandMap()) : value;
} });
function isPluginCommandRegistryLocked() {
	return getState$1().registryLocked;
}
function setPluginCommandRegistryLocked(locked) {
	getState$1().registryLocked = locked;
}
function clearPluginCommands() {
	pluginCommands.clear();
}
function clearPluginCommandsForPlugin(pluginId) {
	for (const [key, cmd] of pluginCommands.entries()) if (cmd.pluginId === pluginId) pluginCommands.delete(key);
}
function isTrustedReservedCommandOwner(command) {
	return command.ownership === "reserved";
}
function listRegisteredPluginCommands() {
	return Array.from(pluginCommands.values());
}
function listRegisteredPluginAgentPromptGuidance() {
	const lines = [];
	const seen = /* @__PURE__ */ new Set();
	for (const command of pluginCommands.values()) for (const line of command.agentPromptGuidance ?? []) {
		const trimmed = line.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		lines.push(trimmed);
	}
	return lines;
}
function restorePluginCommands(commands) {
	pluginCommands.clear();
	for (const command of commands) {
		const name = normalizeOptionalLowercaseString(command.name);
		if (!name) continue;
		pluginCommands.set(`/${name}`, command);
	}
}
//#endregion
//#region src/plugins/interactive-shared.ts
function toPluginInteractiveRegistryKey(channel, namespace) {
	return `${normalizeOptionalLowercaseString(channel) ?? ""}:${namespace.trim()}`;
}
function normalizePluginInteractiveNamespace(namespace) {
	return namespace.trim();
}
function validatePluginInteractiveNamespace(namespace) {
	if (!namespace.trim()) return "Interactive handler namespace cannot be empty";
	if (!/^[A-Za-z0-9._-]+$/.test(namespace.trim())) return "Interactive handler namespace must contain only letters, numbers, dots, underscores, and hyphens";
	return null;
}
function resolvePluginInteractiveMatch(params) {
	const trimmedData = params.data.trim();
	if (!trimmedData) return null;
	const separatorIndex = trimmedData.indexOf(":");
	const namespace = separatorIndex >= 0 ? trimmedData.slice(0, separatorIndex) : normalizePluginInteractiveNamespace(trimmedData);
	const registration = params.interactiveHandlers.get(toPluginInteractiveRegistryKey(params.channel, namespace));
	if (!registration) return null;
	return {
		registration,
		namespace,
		payload: separatorIndex >= 0 ? trimmedData.slice(separatorIndex + 1) : ""
	};
}
//#endregion
//#region src/plugins/interactive-state.ts
const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");
const PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY = Symbol.for("openclaw.pluginInteractiveCallbackDedupe");
function createInteractiveCallbackDedupe() {
	return resolveGlobalDedupeCache(PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY, {
		ttlMs: 5 * 6e4,
		maxSize: 4096
	});
}
function createInteractiveState() {
	return {
		interactiveHandlers: /* @__PURE__ */ new Map(),
		callbackDedupe: createInteractiveCallbackDedupe(),
		inflightCallbackDedupe: /* @__PURE__ */ new Set()
	};
}
function hydrateInteractiveState(value) {
	const state = typeof value === "object" && value !== null ? value : {};
	return {
		interactiveHandlers: state.interactiveHandlers instanceof Map ? state.interactiveHandlers : /* @__PURE__ */ new Map(),
		callbackDedupe: createInteractiveCallbackDedupe(),
		inflightCallbackDedupe: state.inflightCallbackDedupe instanceof Set ? state.inflightCallbackDedupe : /* @__PURE__ */ new Set()
	};
}
function getState() {
	const globalStore = globalThis;
	const existing = globalStore[PLUGIN_INTERACTIVE_STATE_KEY];
	if (existing !== void 0) {
		const hydrated = hydrateInteractiveState(existing);
		globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = hydrated;
		return hydrated;
	}
	const created = createInteractiveState();
	globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = created;
	return created;
}
function getPluginInteractiveHandlersState() {
	return getState().interactiveHandlers;
}
function getPluginInteractiveCallbackDedupeState() {
	return getState().callbackDedupe;
}
function claimPluginInteractiveCallbackDedupe(dedupeKey, now = Date.now()) {
	if (!dedupeKey) return true;
	const state = getState();
	if (state.inflightCallbackDedupe.has(dedupeKey) || state.callbackDedupe.peek(dedupeKey, now)) return false;
	state.inflightCallbackDedupe.add(dedupeKey);
	return true;
}
function commitPluginInteractiveCallbackDedupe(dedupeKey, now = Date.now()) {
	if (!dedupeKey) return;
	const state = getState();
	state.inflightCallbackDedupe.delete(dedupeKey);
	state.callbackDedupe.check(dedupeKey, now);
}
function releasePluginInteractiveCallbackDedupe(dedupeKey) {
	if (!dedupeKey) return;
	getState().inflightCallbackDedupe.delete(dedupeKey);
}
function clearPluginInteractiveHandlersState() {
	clearPluginInteractiveHandlerRegistrationsState();
	getPluginInteractiveCallbackDedupeState().clear();
	getState().inflightCallbackDedupe.clear();
}
function clearPluginInteractiveHandlerRegistrationsState() {
	getPluginInteractiveHandlersState().clear();
}
//#endregion
//#region src/plugins/interactive-registry.ts
function resolvePluginInteractiveNamespaceMatch(channel, data) {
	return resolvePluginInteractiveMatch({
		interactiveHandlers: getPluginInteractiveHandlersState(),
		channel,
		data
	});
}
function registerPluginInteractiveHandler(pluginId, registration, opts) {
	const interactiveHandlers = getPluginInteractiveHandlersState();
	const namespace = normalizePluginInteractiveNamespace(registration.namespace);
	const validationError = validatePluginInteractiveNamespace(namespace);
	if (validationError) return {
		ok: false,
		error: validationError
	};
	const key = toPluginInteractiveRegistryKey(registration.channel, namespace);
	const existing = interactiveHandlers.get(key);
	if (existing) return {
		ok: false,
		error: `Interactive handler namespace "${namespace}" already registered by plugin "${existing.pluginId}"`
	};
	interactiveHandlers.set(key, {
		...registration,
		namespace,
		channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
		pluginId,
		pluginName: opts?.pluginName,
		pluginRoot: opts?.pluginRoot
	});
	return { ok: true };
}
function clearPluginInteractiveHandlers() {
	clearPluginInteractiveHandlersState();
}
function clearPluginInteractiveHandlerRegistrations() {
	clearPluginInteractiveHandlerRegistrationsState();
}
function clearPluginInteractiveHandlersForPlugin(pluginId) {
	const interactiveHandlers = getPluginInteractiveHandlersState();
	for (const [key, value] of interactiveHandlers.entries()) if (value.pluginId === pluginId) interactiveHandlers.delete(key);
}
function listPluginInteractiveHandlers() {
	return Array.from(getPluginInteractiveHandlersState().values());
}
function restorePluginInteractiveHandlers(registrations) {
	clearPluginInteractiveHandlerRegistrations();
	const interactiveHandlers = getPluginInteractiveHandlersState();
	for (const registration of registrations) {
		const namespace = normalizePluginInteractiveNamespace(registration.namespace);
		if (!namespace) continue;
		interactiveHandlers.set(toPluginInteractiveRegistryKey(registration.channel, namespace), {
			...registration,
			namespace,
			channel: normalizeOptionalLowercaseString(registration.channel) ?? ""
		});
	}
}
//#endregion
//#region src/plugins/command-registration.ts
/**
* Reserved command names that plugins cannot override (built-in commands).
*
* Constructed lazily inside validateCommandName to avoid TDZ errors: the
* bundler can place this module's body after call sites within the same
* output chunk, so any module-level const/let would be uninitialized when
* first accessed during plugin registration.
*/
let reservedCommands;
function getReservedCommands() {
	reservedCommands ??= new Set([
		"help",
		"commands",
		"status",
		"diagnostics",
		"codex",
		"whoami",
		"context",
		"btw",
		"stop",
		"restart",
		"reset",
		"new",
		"compact",
		"config",
		"debug",
		"allowlist",
		"activation",
		"skill",
		"subagents",
		"kill",
		"steer",
		"tell",
		"model",
		"models",
		"queue",
		"send",
		"bash",
		"exec",
		"think",
		"verbose",
		"reasoning",
		"elevated",
		"usage"
	]);
	return reservedCommands;
}
function isReservedCommandName(name) {
	const trimmed = normalizeOptionalLowercaseString(name) ?? "";
	return Boolean(trimmed && getReservedCommands().has(trimmed));
}
function validateCommandName(name, opts) {
	const trimmed = normalizeOptionalLowercaseString(name) ?? "";
	if (!trimmed) return "Command name cannot be empty";
	if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
	if (!opts?.allowReservedCommandNames && getReservedCommands().has(trimmed)) return `Command name "${trimmed}" is reserved by a built-in command`;
	return null;
}
/**
* Validate a plugin command definition without registering it.
* Returns an error message if invalid, or null if valid.
* Shared by both the global registration path and snapshot (non-activating) loads.
*/
function validatePluginCommandDefinition(command, opts) {
	if (typeof command.handler !== "function") return "Command handler must be a function";
	if (typeof command.name !== "string") return "Command name must be a string";
	if (typeof command.description !== "string") return "Command description must be a string";
	if (!command.description.trim()) return "Command description cannot be empty";
	if (command.ownership === "reserved") {
		if (!opts?.allowReservedCommandNames) return "Reserved command ownership is only available to bundled reserved commands";
		if (!isReservedCommandName(command.name)) return `Reserved command ownership requires a reserved command name: ${normalizeOptionalLowercaseString(command.name) ?? ""}`;
	}
	if (command.agentPromptGuidance !== void 0 && !Array.isArray(command.agentPromptGuidance)) return "Agent prompt guidance must be an array of strings";
	for (const [index, guidance] of (command.agentPromptGuidance ?? []).entries()) {
		if (typeof guidance !== "string") return `Agent prompt guidance ${index + 1} must be a string`;
		if (!guidance.trim()) return `Agent prompt guidance ${index + 1} cannot be empty`;
	}
	if (command.requiredScopes !== void 0) {
		if (!Array.isArray(command.requiredScopes)) return "Command requiredScopes must be an array of operator scopes";
		const unknownScope = command.requiredScopes.find((scope) => !isOperatorScope(scope));
		if (unknownScope) return typeof unknownScope === "string" ? `Command requiredScopes contains unknown operator scope: ${unknownScope}` : "Command requiredScopes contains unknown operator scope";
	}
	if (command.channels !== void 0) {
		if (!Array.isArray(command.channels)) return "Command channels must be an array of channel ids";
		for (const [index, channel] of command.channels.entries()) {
			if (typeof channel !== "string") return `Command channel ${index + 1} must be a string`;
			if (!channel.trim()) return `Command channel ${index + 1} cannot be empty`;
		}
	}
	const nameError = validateCommandName(command.name.trim(), opts);
	if (nameError) return nameError;
	for (const [label, alias] of Object.entries(command.nativeNames ?? {})) {
		if (typeof alias !== "string") continue;
		const aliasError = validateCommandName(alias.trim());
		if (aliasError) return `Native command alias "${label}" invalid: ${aliasError}`;
	}
	for (const [label, message] of Object.entries(command.nativeProgressMessages ?? {})) {
		if (typeof message !== "string") return `Native progress message "${label}" must be a string`;
		if (!message.trim()) return `Native progress message "${label}" cannot be empty`;
	}
	for (const [locale, description] of Object.entries(command.descriptionLocalizations ?? {})) {
		if (typeof description !== "string") return `Description localization "${locale}" must be a string`;
		if (!description.trim()) return `Description localization "${locale}" cannot be empty`;
	}
	return null;
}
function listPluginInvocationKeys(command) {
	const keys = /* @__PURE__ */ new Set();
	const push = (value) => {
		const normalized = normalizeOptionalLowercaseString(value);
		if (!normalized) return;
		keys.add(`/${normalized}`);
	};
	push(command.name);
	for (const alias of Object.values(command.nativeNames ?? {})) if (typeof alias === "string") push(alias);
	return [...keys];
}
function pluginCommandSupportsChannel(command, channel) {
	if (!command.channels || command.channels.length === 0 || !channel) return true;
	const normalizedChannel = normalizeLowercaseStringOrEmpty(channel);
	return command.channels.some((entry) => normalizeLowercaseStringOrEmpty(entry) === normalizedChannel);
}
function registerPluginCommand(pluginId, command, opts) {
	if (isPluginCommandRegistryLocked()) return {
		ok: false,
		error: "Cannot register commands while processing is in progress"
	};
	if (command.ownership === "reserved") return {
		ok: false,
		error: "Reserved command ownership is only available to bundled reserved commands"
	};
	const definitionError = validatePluginCommandDefinition(command, opts);
	if (definitionError) return {
		ok: false,
		error: definitionError
	};
	const name = command.name.trim();
	const normalizedName = normalizeLowercaseStringOrEmpty(name);
	const description = command.description.trim();
	const normalizedCommand = {
		...command,
		name,
		description,
		...command.channels ? { channels: command.channels.map((channel) => normalizeLowercaseStringOrEmpty(channel)) } : {},
		...command.agentPromptGuidance ? { agentPromptGuidance: command.agentPromptGuidance.map((line) => line.trim()) } : {}
	};
	const invocationKeys = listPluginInvocationKeys(normalizedCommand);
	const key = `/${normalizedName}`;
	for (const invocationKey of invocationKeys) {
		const existing = pluginCommands.get(invocationKey) ?? Array.from(pluginCommands.values()).find((candidate) => listPluginInvocationKeys(candidate).includes(invocationKey));
		if (existing) return {
			ok: false,
			error: `Command "${invocationKey.slice(1)}" already registered by plugin "${existing.pluginId}"`
		};
	}
	pluginCommands.set(key, {
		...normalizedCommand,
		pluginId,
		pluginName: opts?.pluginName,
		pluginRoot: opts?.pluginRoot
	});
	logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
	return { ok: true };
}
//#endregion
//#region src/plugins/hook-before-agent-start.types.ts
const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = [
	"systemPrompt",
	"prependContext",
	"appendContext",
	"prependSystemContext",
	"appendSystemContext"
];
const stripPromptMutationFieldsFromLegacyHookResult = (result) => {
	if (!result || typeof result !== "object") return result;
	const remaining = { ...result };
	for (const field of PLUGIN_PROMPT_MUTATION_RESULT_FIELDS) delete remaining[field];
	return Object.keys(remaining).length > 0 ? remaining : void 0;
};
//#endregion
//#region src/plugins/hook-types.ts
const PLUGIN_HOOK_NAMES = [
	"before_model_resolve",
	"agent_turn_prepare",
	"before_prompt_build",
	"before_agent_start",
	"before_agent_reply",
	"model_call_started",
	"model_call_ended",
	"llm_input",
	"llm_output",
	"before_agent_finalize",
	"agent_end",
	"before_compaction",
	"after_compaction",
	"before_reset",
	"inbound_claim",
	"message_received",
	"message_sending",
	"message_sent",
	"before_tool_call",
	"after_tool_call",
	"tool_result_persist",
	"before_message_write",
	"session_start",
	"session_end",
	"subagent_spawning",
	"subagent_delivery_target",
	"subagent_spawned",
	"subagent_ended",
	"gateway_start",
	"gateway_stop",
	"heartbeat_prompt_contribution",
	"cron_changed",
	"before_dispatch",
	"reply_dispatch",
	"before_install",
	"before_agent_run"
];
const pluginHookNameSet = new Set(PLUGIN_HOOK_NAMES);
const isPluginHookName = (hookName) => typeof hookName === "string" && pluginHookNameSet.has(hookName);
const PROMPT_INJECTION_HOOK_NAMES = [
	"agent_turn_prepare",
	"before_prompt_build",
	"before_agent_start",
	"heartbeat_prompt_contribution"
];
const promptInjectionHookNameSet = new Set(PROMPT_INJECTION_HOOK_NAMES);
const isPromptInjectionHookName = (hookName) => promptInjectionHookNameSet.has(hookName);
const CONVERSATION_HOOK_NAMES = [
	"before_model_resolve",
	"before_agent_reply",
	"llm_input",
	"llm_output",
	"before_agent_finalize",
	"agent_end",
	"before_agent_run"
];
const conversationHookNameSet = new Set(CONVERSATION_HOOK_NAMES);
const isConversationHookName = (hookName) => conversationHookNameSet.has(hookName);
const PluginApprovalResolutions = {
	ALLOW_ONCE: "allow-once",
	ALLOW_ALWAYS: "allow-always",
	DENY: "deny",
	TIMEOUT: "timeout",
	CANCELLED: "cancelled"
};
//#endregion
export { pluginCommands as A, commitPluginInteractiveCallbackDedupe as C, isTrustedReservedCommandOwner as D, clearPluginCommandsForPlugin as E, setPluginCommandRegistryLocked as M, listRegisteredPluginAgentPromptGuidance as O, claimPluginInteractiveCallbackDedupe as S, clearPluginCommands as T, clearPluginInteractiveHandlersForPlugin as _, isConversationHookName as a, resolvePluginInteractiveNamespaceMatch as b, PLUGIN_PROMPT_MUTATION_RESULT_FIELDS as c, listPluginInvocationKeys as d, pluginCommandSupportsChannel as f, clearPluginInteractiveHandlers as g, validatePluginCommandDefinition as h, PluginApprovalResolutions as i, restorePluginCommands as j, listRegisteredPluginCommands as k, stripPromptMutationFieldsFromLegacyHookResult as l, validateCommandName as m, PLUGIN_HOOK_NAMES as n, isPluginHookName as o, registerPluginCommand as p, PROMPT_INJECTION_HOOK_NAMES as r, isPromptInjectionHookName as s, CONVERSATION_HOOK_NAMES as t, isReservedCommandName as u, listPluginInteractiveHandlers as v, releasePluginInteractiveCallbackDedupe as w, restorePluginInteractiveHandlers as x, registerPluginInteractiveHandler as y };
