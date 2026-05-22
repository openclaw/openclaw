import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
//#region extensions/codex/src/app-server/config.ts
const START_OPTIONS_KEY_SECRET = randomBytes(32);
const DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME = "computer-use";
const DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME = "computer-use";
const DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS = 6e4;
const codexAppServerTransportSchema = z.enum(["stdio", "websocket"]);
const codexAppServerPolicyModeSchema = z.enum(["yolo", "guardian"]);
const codexAppServerApprovalPolicySchema = z.enum([
	"never",
	"on-request",
	"on-failure",
	"untrusted"
]);
const codexAppServerSandboxSchema = z.enum([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
const codexAppServerApprovalsReviewerSchema = z.enum([
	"user",
	"auto_review",
	"guardian_subagent"
]);
const codexDynamicToolsProfileSchema = z.enum(["native-first", "openclaw-compat"]);
const codexAppServerServiceTierSchema = z.preprocess((value) => value === null ? null : resolveServiceTier(value), z.enum(["fast", "flex"]).nullable().optional()).optional();
const codexPluginConfigSchema = z.object({
	codexDynamicToolsProfile: codexDynamicToolsProfileSchema.optional(),
	codexDynamicToolsExclude: z.array(z.string()).optional(),
	discovery: z.object({
		enabled: z.boolean().optional(),
		timeoutMs: z.number().positive().optional()
	}).strict().optional(),
	computerUse: z.object({
		enabled: z.boolean().optional(),
		autoInstall: z.boolean().optional(),
		marketplaceDiscoveryTimeoutMs: z.number().positive().optional(),
		marketplaceSource: z.string().optional(),
		marketplacePath: z.string().optional(),
		marketplaceName: z.string().optional(),
		pluginName: z.string().optional(),
		mcpServerName: z.string().optional()
	}).strict().optional(),
	appServer: z.object({
		mode: codexAppServerPolicyModeSchema.optional(),
		transport: codexAppServerTransportSchema.optional(),
		command: z.string().optional(),
		args: z.union([z.array(z.string()), z.string()]).optional(),
		url: z.string().optional(),
		authToken: z.string().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		clearEnv: z.array(z.string()).optional(),
		requestTimeoutMs: z.number().positive().optional(),
		approvalPolicy: codexAppServerApprovalPolicySchema.optional(),
		sandbox: codexAppServerSandboxSchema.optional(),
		approvalsReviewer: codexAppServerApprovalsReviewerSchema.optional(),
		serviceTier: codexAppServerServiceTierSchema,
		defaultWorkspaceDir: z.string().optional()
	}).strict().optional()
}).strict();
function readCodexPluginConfig(value) {
	const parsed = codexPluginConfigSchema.safeParse(value);
	return parsed.success ? parsed.data : {};
}
function resolveCodexAppServerRuntimeOptions(params = {}) {
	const env = params.env ?? process.env;
	const config = readCodexPluginConfig(params.pluginConfig).appServer ?? {};
	const transport = resolveTransport(config.transport);
	const configCommand = readNonEmptyString(config.command);
	const envCommand = readNonEmptyString(env.OPENCLAW_CODEX_APP_SERVER_BIN);
	const command = configCommand ?? envCommand ?? "codex";
	const commandSource = configCommand ? "config" : envCommand ? "env" : "managed";
	const args = resolveArgs(config.args, env.OPENCLAW_CODEX_APP_SERVER_ARGS);
	const headers = normalizeHeaders(config.headers);
	const clearEnv = normalizeStringList(config.clearEnv);
	const authToken = readNonEmptyString(config.authToken);
	const url = readNonEmptyString(config.url);
	const policyMode = resolvePolicyMode(config.mode) ?? resolvePolicyMode(env.OPENCLAW_CODEX_APP_SERVER_MODE) ?? "yolo";
	const serviceTier = resolveServiceTier(config.serviceTier);
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
		requestTimeoutMs: normalizePositiveNumber(config.requestTimeoutMs, 6e4),
		approvalPolicy: resolveApprovalPolicy(config.approvalPolicy) ?? resolveApprovalPolicy(env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY) ?? (policyMode === "guardian" ? "on-request" : "never"),
		sandbox: resolveSandbox(config.sandbox) ?? resolveSandbox(env.OPENCLAW_CODEX_APP_SERVER_SANDBOX) ?? (policyMode === "guardian" ? "workspace-write" : "danger-full-access"),
		approvalsReviewer: resolveApprovalsReviewer(config.approvalsReviewer) ?? (policyMode === "guardian" ? "auto_review" : "user"),
		...serviceTier ? { serviceTier } : {}
	};
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
		access: { type: "fullAccess" },
		networkAccess: false
	};
	return {
		type: "workspaceWrite",
		writableRoots: [cwd],
		readOnlyAccess: { type: "fullAccess" },
		networkAccess: false,
		excludeTmpdirEnvVar: false,
		excludeSlashTmp: false
	};
}
function resolveTransport(value) {
	return value === "websocket" ? "websocket" : "stdio";
}
function resolvePolicyMode(value) {
	return value === "guardian" || value === "yolo" ? value : void 0;
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
function resolveServiceTier(value) {
	return value === "fast" || value === "flex" ? value : void 0;
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
export { resolveCodexComputerUseConfig as a, resolveCodexAppServerRuntimeOptions as i, codexSandboxPolicyForTurn as n, readCodexPluginConfig as r, codexAppServerStartOptionsKey as t };
