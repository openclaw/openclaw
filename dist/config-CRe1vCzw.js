import { An as preprocess, At as boolean, Et as array, Nn as record, Rn as string, Tn as object, Xn as union, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { n as detectWindowsSpawnCommandInlineArgs } from "./windows-spawn-B76fGM3V.js";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createHmac, randomBytes } from "node:crypto";
//#region extensions/codex/src/app-server/config.ts
const START_OPTIONS_KEY_SECRET_SYMBOL = Symbol.for("openclaw.codexAppServerStartOptionsKeySecret");
const START_OPTIONS_KEY_SECRET = getStartOptionsKeySecret();
const UNIX_CODEX_REQUIREMENTS_PATH = "/etc/codex/requirements.toml";
const WINDOWS_CODEX_REQUIREMENTS_SUFFIX = "\\OpenAI\\Codex\\requirements.toml";
const CODEX_PLUGINS_MARKETPLACE_NAME = "openai-curated";
const DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME = "computer-use";
const DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME = "computer-use";
const DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS = 6e4;
const codexAppServerTransportSchema = _enum(["stdio", "websocket"]);
const codexAppServerPolicyModeSchema = _enum(["yolo", "guardian"]);
const codexAppServerApprovalPolicySchema = _enum([
	"never",
	"on-request",
	"on-failure",
	"untrusted"
]);
const codexAppServerSandboxSchema = _enum([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
const codexAppServerApprovalsReviewerSchema = _enum([
	"user",
	"auto_review",
	"guardian_subagent"
]);
const codexDynamicToolsLoadingSchema = _enum(["searchable", "direct"]);
const codexAppServerServiceTierSchema = preprocess((value) => value === null ? null : normalizeCodexServiceTier(value), string().trim().min(1).nullable().optional()).optional();
const codexAppServerExperimentalSchema = object({ sandboxExecServer: boolean().optional() }).strict();
const codexPluginEntryConfigSchema = object({
	enabled: boolean().optional(),
	marketplaceName: literal(CODEX_PLUGINS_MARKETPLACE_NAME).optional(),
	pluginName: string().trim().min(1).optional(),
	allow_destructive_actions: boolean().optional()
}).strict();
const codexPluginsConfigSchema = object({
	enabled: boolean().optional(),
	allow_destructive_actions: boolean().optional(),
	plugins: record(string(), codexPluginEntryConfigSchema).optional()
}).strict();
const codexPluginConfigSchema = object({
	codexDynamicToolsLoading: codexDynamicToolsLoadingSchema.optional(),
	codexDynamicToolsExclude: array(string()).optional(),
	discovery: object({
		enabled: boolean().optional(),
		timeoutMs: number().positive().optional()
	}).strict().optional(),
	computerUse: object({
		enabled: boolean().optional(),
		autoInstall: boolean().optional(),
		marketplaceDiscoveryTimeoutMs: number().positive().optional(),
		marketplaceSource: string().optional(),
		marketplacePath: string().optional(),
		marketplaceName: string().optional(),
		pluginName: string().optional(),
		mcpServerName: string().optional()
	}).strict().optional(),
	codexPlugins: unknown().optional(),
	appServer: object({
		mode: codexAppServerPolicyModeSchema.optional(),
		transport: codexAppServerTransportSchema.optional(),
		command: string().optional(),
		args: union([array(string()), string()]).optional(),
		url: string().optional(),
		authToken: string().optional(),
		headers: record(string(), string()).optional(),
		clearEnv: array(string()).optional(),
		codeModeOnly: boolean().optional(),
		requestTimeoutMs: number().positive().optional(),
		turnCompletionIdleTimeoutMs: number().positive().optional(),
		postToolRawAssistantCompletionIdleTimeoutMs: number().positive().optional(),
		approvalPolicy: codexAppServerApprovalPolicySchema.optional(),
		sandbox: codexAppServerSandboxSchema.optional(),
		approvalsReviewer: codexAppServerApprovalsReviewerSchema.optional(),
		serviceTier: codexAppServerServiceTierSchema,
		defaultWorkspaceDir: string().optional(),
		experimental: codexAppServerExperimentalSchema.optional()
	}).strict().optional()
}).strict();
function readCodexPluginConfig(value) {
	const parsed = codexPluginConfigSchema.safeParse(value);
	if (!parsed.success) return {};
	const { codexPlugins: rawCodexPlugins, ...config } = parsed.data;
	const plugins = codexPluginsConfigSchema.safeParse(rawCodexPlugins);
	if (!plugins.success) return config;
	return {
		...config,
		...plugins.data ? { codexPlugins: plugins.data } : {}
	};
}
function isCodexSandboxExecServerEnabled(pluginConfig) {
	return readCodexPluginConfig(pluginConfig).appServer?.experimental?.sandboxExecServer === true;
}
function assertCodexAppServerCommandHasNoInlineArgs(params) {
	const inlineArgs = detectWindowsSpawnCommandInlineArgs(params.command);
	if (!inlineArgs) return;
	const sourceLabel = params.source === "env" ? "OPENCLAW_CODEX_APP_SERVER_BIN" : "plugins.entries.codex.config.appServer.command";
	const argsLabel = params.source === "env" ? "OPENCLAW_CODEX_APP_SERVER_ARGS" : "plugins.entries.codex.config.appServer.args";
	throw new Error(`${sourceLabel} must be only the Codex app-server executable path; "${inlineArgs.executable}" was configured with inline arguments "${inlineArgs.arguments}". Move those arguments to ${argsLabel}, or remove the override to use the managed Codex startup path.`);
}
function resolveCodexPluginsPolicy(pluginConfig) {
	const config = readCodexPluginConfig(pluginConfig).codexPlugins;
	const configured = config !== void 0;
	const enabled = config?.enabled === true;
	const allowDestructiveActions = config?.allow_destructive_actions ?? true;
	return {
		configured,
		enabled,
		allowDestructiveActions,
		pluginPolicies: Object.entries(config?.plugins ?? {}).flatMap(([configKey, entry]) => {
			if (entry.marketplaceName !== "openai-curated" || !entry.pluginName) return [];
			return [{
				configKey,
				marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
				pluginName: entry.pluginName,
				enabled: enabled && entry.enabled !== false,
				allowDestructiveActions: entry.allow_destructive_actions ?? allowDestructiveActions
			}];
		}).toSorted((left, right) => left.configKey.localeCompare(right.configKey))
	};
}
function resolveCodexAppServerRuntimeOptions(params = {}) {
	const env = params.env ?? process.env;
	const config = readCodexPluginConfig(params.pluginConfig).appServer ?? {};
	const transport = resolveTransport(config.transport);
	const configCommand = readNonEmptyString(config.command);
	const envCommand = readNonEmptyString(env.OPENCLAW_CODEX_APP_SERVER_BIN);
	const command = configCommand ?? envCommand ?? "codex";
	const commandSource = configCommand ? "config" : envCommand ? "env" : "managed";
	if (commandSource === "config" || commandSource === "env") assertCodexAppServerCommandHasNoInlineArgs({
		command,
		source: commandSource
	});
	const args = resolveArgs(config.args, env.OPENCLAW_CODEX_APP_SERVER_ARGS);
	const headers = normalizeHeaders(config.headers);
	const clearEnv = normalizeStringList(config.clearEnv);
	const authToken = readNonEmptyString(config.authToken);
	const url = readNonEmptyString(config.url);
	const explicitPolicyMode = resolvePolicyMode(config.mode) ?? resolvePolicyMode(env.OPENCLAW_CODEX_APP_SERVER_MODE);
	const defaultPolicy = explicitPolicyMode ? void 0 : resolveDefaultCodexAppServerPolicy({
		transport,
		env,
		requirementsToml: params.requirementsToml,
		requirementsPath: params.requirementsPath,
		readRequirementsFile: params.readRequirementsFile,
		platform: params.platform,
		hostName: params.hostName
	});
	const policyMode = explicitPolicyMode ?? defaultPolicy?.mode ?? "yolo";
	const serviceTier = normalizeCodexServiceTier(config.serviceTier);
	if (transport === "websocket" && !url) throw new Error("plugins.entries.codex.config.appServer.url is required when appServer.transport is websocket");
	return {
		start: {
			transport,
			command,
			commandSource,
			args: args.length > 0 ? args : [
				"app-server",
				"--listen",
				"stdio://"
			],
			...url ? { url } : {},
			...authToken ? { authToken } : {},
			headers,
			...transport === "stdio" && clearEnv.length > 0 ? { clearEnv } : {}
		},
		codeModeOnly: config.codeModeOnly === true,
		requestTimeoutMs: normalizePositiveNumber(config.requestTimeoutMs, 6e4),
		turnCompletionIdleTimeoutMs: normalizePositiveNumber(config.turnCompletionIdleTimeoutMs, 6e4),
		...config.postToolRawAssistantCompletionIdleTimeoutMs !== void 0 ? { postToolRawAssistantCompletionIdleTimeoutMs: normalizePositiveNumber(config.postToolRawAssistantCompletionIdleTimeoutMs, 6e4) } : {},
		approvalPolicy: resolveApprovalPolicy(config.approvalPolicy) ?? resolveApprovalPolicy(env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY) ?? defaultPolicy?.approvalPolicy ?? (policyMode === "guardian" ? "on-request" : "never"),
		sandbox: resolveSandbox(config.sandbox) ?? resolveSandbox(env.OPENCLAW_CODEX_APP_SERVER_SANDBOX) ?? defaultPolicy?.sandbox ?? (policyMode === "guardian" ? "workspace-write" : "danger-full-access"),
		approvalsReviewer: resolveApprovalsReviewer(config.approvalsReviewer) ?? defaultPolicy?.approvalsReviewer ?? (policyMode === "guardian" ? "auto_review" : "user"),
		...serviceTier ? { serviceTier } : {}
	};
}
function isCodexAppServerApprovalPolicyAllowedByRequirements(policy, params = {}) {
	const content = readCodexRequirementsToml(params);
	if (content === void 0) return true;
	const allowedApprovalPolicies = parseAllowedApprovalPoliciesFromCodexRequirements(content);
	return allowedApprovalPolicies === void 0 || allowedApprovalPolicies.has(policy);
}
function resolveCodexComputerUseConfig(params = {}) {
	const env = params.env ?? process.env;
	const config = readCodexPluginConfig(params.pluginConfig).computerUse ?? {};
	const marketplaceSource = readNonEmptyString(params.overrides?.marketplaceSource) ?? readNonEmptyString(config.marketplaceSource) ?? readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_SOURCE);
	const marketplacePath = readNonEmptyString(params.overrides?.marketplacePath) ?? readNonEmptyString(config.marketplacePath) ?? readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_PATH);
	const marketplaceName = readNonEmptyString(params.overrides?.marketplaceName) ?? readNonEmptyString(config.marketplaceName) ?? readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_NAME);
	const autoInstall = params.overrides?.autoInstall ?? config.autoInstall ?? readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE_AUTO_INSTALL) ?? false;
	const marketplaceDiscoveryTimeoutMs = normalizePositiveNumber(params.overrides?.marketplaceDiscoveryTimeoutMs ?? config.marketplaceDiscoveryTimeoutMs ?? readNumberEnv(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS), DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS);
	return {
		enabled: params.overrides?.enabled ?? config.enabled ?? readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE) ?? Boolean(autoInstall || marketplaceSource || marketplacePath || marketplaceName),
		autoInstall,
		marketplaceDiscoveryTimeoutMs,
		pluginName: readNonEmptyString(params.overrides?.pluginName) ?? readNonEmptyString(config.pluginName) ?? readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_NAME) ?? DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME,
		mcpServerName: readNonEmptyString(params.overrides?.mcpServerName) ?? readNonEmptyString(config.mcpServerName) ?? readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MCP_SERVER_NAME) ?? DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME,
		...marketplaceSource ? { marketplaceSource } : {},
		...marketplacePath ? { marketplacePath } : {},
		...marketplaceName ? { marketplaceName } : {}
	};
}
function codexAppServerStartOptionsKey(options, params = {}) {
	return JSON.stringify({
		transport: options.transport,
		command: options.command,
		commandSource: options.commandSource ?? null,
		args: options.args,
		url: options.url ?? null,
		authToken: hashSecretForKey(options.authToken, "authToken"),
		headers: Object.entries(options.headers).toSorted(([left], [right]) => left.localeCompare(right)),
		env: Object.entries(options.env ?? {}).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, hashSecretForKey(value, `env:${key}`)]),
		clearEnv: [...options.clearEnv ?? []].toSorted(),
		authProfileId: params.authProfileId ?? null,
		agentDir: params.agentDir ?? null
	});
}
function codexSandboxPolicyForTurn(mode, cwd) {
	if (mode === "danger-full-access") return { type: "dangerFullAccess" };
	if (mode === "read-only") return {
		type: "readOnly",
		networkAccess: false
	};
	return {
		type: "workspaceWrite",
		writableRoots: [cwd],
		networkAccess: false,
		excludeTmpdirEnvVar: false,
		excludeSlashTmp: false
	};
}
function withMcpElicitationsApprovalPolicy(policy) {
	if (typeof policy !== "string") return { granular: {
		...policy.granular,
		mcp_elicitations: true
	} };
	if (policy === "never") return { granular: {
		mcp_elicitations: true,
		rules: false,
		sandbox_approval: false
	} };
	return { granular: {
		mcp_elicitations: true,
		rules: true,
		sandbox_approval: true
	} };
}
function resolveTransport(value) {
	return value === "websocket" ? "websocket" : "stdio";
}
function resolvePolicyMode(value) {
	return value === "guardian" || value === "yolo" ? value : void 0;
}
function resolveDefaultCodexAppServerPolicy(params) {
	if (params.transport !== "stdio") return { mode: "yolo" };
	const content = readCodexRequirementsToml(params);
	if (content === void 0) return { mode: "yolo" };
	const allowedSandboxModes = parseAllowedSandboxModesFromCodexRequirements(content, readNonEmptyString(params.hostName) ?? hostname());
	const allowedApprovalPolicies = parseAllowedApprovalPoliciesFromCodexRequirements(content);
	const allowedApprovalsReviewers = parseAllowedApprovalsReviewersFromCodexRequirements(content);
	const yoloSandboxAllowed = allowedSandboxModes === void 0 || allowedSandboxModes.has("danger-full-access");
	const yoloApprovalAllowed = allowedApprovalPolicies === void 0 || allowedApprovalPolicies.has("never");
	const yoloReviewerAllowed = allowedApprovalsReviewers === void 0 || allowedApprovalsReviewers.has("user");
	if (yoloSandboxAllowed && yoloApprovalAllowed && yoloReviewerAllowed) return { mode: "yolo" };
	return {
		mode: "guardian",
		approvalPolicy: selectGuardianApprovalPolicy(allowedApprovalPolicies),
		approvalsReviewer: selectGuardianApprovalsReviewer(allowedApprovalsReviewers),
		sandbox: selectGuardianSandbox(allowedSandboxModes)
	};
}
function readCodexRequirementsToml(params) {
	if (params.requirementsToml !== void 0) return params.requirementsToml ?? void 0;
	const path = readNonEmptyString(params.requirementsPath) ?? resolveCodexRequirementsPath(params.env ?? process.env, params.platform ?? process.platform);
	try {
		if (params.readRequirementsFile) return params.readRequirementsFile(path);
		return readFileSync(path, "utf8");
	} catch {
		return;
	}
}
function resolveCodexRequirementsPath(env, platform) {
	if (platform === "win32") return `${(readNonEmptyString(env.ProgramData) ?? "C:\\ProgramData").replace(/[\\/]+$/, "")}${WINDOWS_CODEX_REQUIREMENTS_SUFFIX}`;
	return UNIX_CODEX_REQUIREMENTS_PATH;
}
function parseAllowedSandboxModesFromCodexRequirements(content, hostName) {
	const remoteSandboxModes = parseMatchingRemoteSandboxModesFromCodexRequirements(content, hostName);
	if (remoteSandboxModes !== void 0) return remoteSandboxModes;
	return parseRequirementsSandboxModes(parseTopLevelRequirementsStringArray(content, "allowed_sandbox_modes"));
}
function parseAllowedApprovalPoliciesFromCodexRequirements(content) {
	const values = parseTopLevelRequirementsStringArray(content, "allowed_approval_policies");
	if (values === void 0) return;
	const normalizedPolicies = values.map((entry) => normalizeRequirementsApprovalPolicy(entry)).filter((entry) => entry !== void 0);
	return normalizedPolicies.length > 0 ? new Set(normalizedPolicies) : void 0;
}
function parseAllowedApprovalsReviewersFromCodexRequirements(content) {
	const values = parseTopLevelRequirementsStringArray(content, "allowed_approvals_reviewers");
	if (values === void 0) return;
	const normalizedReviewers = values.map((entry) => normalizeRequirementsApprovalsReviewer(entry)).filter((entry) => entry !== void 0);
	return normalizedReviewers.length > 0 ? new Set(normalizedReviewers) : void 0;
}
function parseMatchingRemoteSandboxModesFromCodexRequirements(content, hostName) {
	const normalizedHostName = normalizeRequirementsHostName(hostName);
	if (normalizedHostName === void 0) return;
	for (const section of parseTomlArrayTableSections(content, "remote_sandbox_config")) {
		const patterns = parseRequirementsStringArray(section, "hostname_patterns");
		if (!patterns || !requirementsHostNameMatchesAnyPattern(normalizedHostName, patterns)) continue;
		return parseRequirementsSandboxModes(parseRequirementsStringArray(section, "allowed_sandbox_modes"));
	}
}
function parseRequirementsSandboxModes(values) {
	if (values === void 0) return;
	const normalizedModes = values.map((entry) => normalizeRequirementsSandboxMode(entry)).filter((entry) => entry !== void 0);
	return normalizedModes.length > 0 ? new Set(normalizedModes) : void 0;
}
function parseTopLevelRequirementsStringArray(content, key) {
	return parseRequirementsStringArray(stripTomlLineComments(content).slice(0, firstTomlTableOffset(content)), key);
}
function parseRequirementsStringArray(content, key) {
	const match = content.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
	if (!match) return;
	const arrayBody = match[1] ?? "";
	const stringMatches = [...arrayBody.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)];
	if (stringMatches.length === 0 && arrayBody.trim().length > 0) return;
	return stringMatches.map((entry) => entry[1] ?? entry[2] ?? "");
}
function parseTomlArrayTableSections(content, table) {
	const strippedContent = stripTomlLineComments(content);
	const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headerPattern = new RegExp(`^\\s*\\[\\[\\s*${escapedTable}\\s*\\]\\]\\s*$`, "gm");
	const sections = [];
	for (let match = headerPattern.exec(strippedContent); match; match = headerPattern.exec(strippedContent)) {
		const sectionStart = headerPattern.lastIndex;
		const rest = strippedContent.slice(sectionStart);
		const nextTableOffset = rest.search(/^\s*\[/m);
		sections.push(nextTableOffset === -1 ? rest : rest.slice(0, nextTableOffset));
	}
	return sections;
}
function firstTomlTableOffset(content) {
	return content.match(/^\s*\[[^\]\n]/m)?.index ?? content.length;
}
function stripTomlLineComments(value) {
	let output = "";
	let quote;
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index] ?? "";
		if (quote) {
			output += char;
			if (quote === "\"" && escaped) {
				escaped = false;
				continue;
			}
			if (quote === "\"" && char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) quote = void 0;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			output += char;
			continue;
		}
		if (char === "#") {
			while (index < value.length && value[index] !== "\n") index += 1;
			if (value[index] === "\n") output += "\n";
			continue;
		}
		output += char;
	}
	return output;
}
function normalizeRequirementsSandboxMode(value) {
	const compact = value.replace(/[\s_-]/g, "").toLowerCase();
	if (compact === "readonly") return "read-only";
	if (compact === "workspacewrite") return "workspace-write";
	if (compact === "dangerfullaccess") return "danger-full-access";
}
function normalizeRequirementsHostName(value) {
	const normalized = value.trim().replace(/\.+$/g, "").toLowerCase();
	return normalized.length > 0 ? normalized : void 0;
}
function requirementsHostNameMatchesAnyPattern(hostName, patterns) {
	return patterns.some((pattern) => {
		const normalizedPattern = normalizeRequirementsHostName(pattern);
		return normalizedPattern !== void 0 && globPatternMatches(hostName, normalizedPattern);
	});
}
function globPatternMatches(value, pattern) {
	let regex = "^";
	for (const char of pattern) if (char === "*") regex += ".*";
	else if (char === "?") regex += ".";
	else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	regex += "$";
	return new RegExp(regex).test(value);
}
function normalizeRequirementsApprovalPolicy(value) {
	return resolveApprovalPolicy(value.trim().toLowerCase());
}
function normalizeRequirementsApprovalsReviewer(value) {
	return resolveApprovalsReviewer(value.trim().toLowerCase());
}
function selectGuardianApprovalPolicy(allowedApprovalPolicies) {
	if (allowedApprovalPolicies === void 0 || allowedApprovalPolicies.has("on-request")) return "on-request";
	if (allowedApprovalPolicies.has("on-failure")) return "on-failure";
	if (allowedApprovalPolicies.has("untrusted")) return "untrusted";
	if (allowedApprovalPolicies.has("never")) return "never";
	return "on-request";
}
function selectGuardianApprovalsReviewer(allowedApprovalsReviewers) {
	if (allowedApprovalsReviewers === void 0 || allowedApprovalsReviewers.has("auto_review")) return "auto_review";
	if (allowedApprovalsReviewers.has("guardian_subagent")) return "guardian_subagent";
	if (allowedApprovalsReviewers.has("user")) return "user";
	return "auto_review";
}
function selectGuardianSandbox(allowedSandboxModes) {
	if (allowedSandboxModes === void 0 || allowedSandboxModes.has("workspace-write")) return "workspace-write";
	if (allowedSandboxModes.has("read-only")) return "read-only";
	if (allowedSandboxModes.has("danger-full-access")) return "danger-full-access";
	return "workspace-write";
}
function resolveApprovalPolicy(value) {
	return value === "on-request" || value === "on-failure" || value === "untrusted" || value === "never" ? value : void 0;
}
function resolveSandbox(value) {
	return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : void 0;
}
function resolveApprovalsReviewer(value) {
	return value === "auto_review" || value === "guardian_subagent" || value === "user" ? value : void 0;
}
function normalizeCodexServiceTier(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const normalized = trimmed.toLowerCase();
	if (normalized === "fast" || normalized === "priority") return "priority";
	if (normalized === "flex") return "flex";
	return trimmed;
}
function isCodexFastServiceTier(value) {
	return normalizeCodexServiceTier(value) === "priority";
}
function normalizePositiveNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function normalizeHeaders(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).map(([key, child]) => [key.trim(), readNonEmptyString(child)]).filter((entry) => Boolean(entry[0] && entry[1])));
}
function normalizeStringList(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => readNonEmptyString(entry)).filter((entry) => entry !== void 0);
}
function readBooleanEnv(value) {
	if (value === void 0) return;
	const normalized = value.trim().toLowerCase();
	if ([
		"1",
		"true",
		"yes",
		"on"
	].includes(normalized)) return true;
	if ([
		"0",
		"false",
		"no",
		"off"
	].includes(normalized)) return false;
}
function readNumberEnv(value) {
	if (value === void 0) return;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function resolveArgs(configArgs, envArgs) {
	if (Array.isArray(configArgs)) return configArgs.map((entry) => readNonEmptyString(entry)).filter((entry) => entry !== void 0);
	if (typeof configArgs === "string") return splitShellWords(configArgs);
	return splitShellWords(envArgs ?? "");
}
function readNonEmptyString(value) {
	if (typeof value !== "string") return;
	return value.trim() || void 0;
}
function hashSecretForKey(value, label) {
	if (!value) return null;
	return createHmac("sha256", START_OPTIONS_KEY_SECRET).update(label).update("\0").update(value).digest("hex");
}
function getStartOptionsKeySecret() {
	const globalState = globalThis;
	globalState[START_OPTIONS_KEY_SECRET_SYMBOL] ??= randomBytes(32);
	return globalState[START_OPTIONS_KEY_SECRET_SYMBOL];
}
function splitShellWords(value) {
	const words = [];
	let current = "";
	let quote = null;
	for (const char of value) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) words.push(current);
	return words;
}
//#endregion
export { isCodexFastServiceTier as a, readCodexPluginConfig as c, resolveCodexPluginsPolicy as d, withMcpElicitationsApprovalPolicy as f, isCodexAppServerApprovalPolicyAllowedByRequirements as i, resolveCodexAppServerRuntimeOptions as l, codexAppServerStartOptionsKey as n, isCodexSandboxExecServerEnabled as o, codexSandboxPolicyForTurn as r, normalizeCodexServiceTier as s, CODEX_PLUGINS_MARKETPLACE_NAME as t, resolveCodexComputerUseConfig as u };
