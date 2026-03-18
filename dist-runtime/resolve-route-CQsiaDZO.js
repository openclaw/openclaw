import { n as __esmMin, r as __exportAll } from "./chunk-DORXReHP.js";
import { _ as init_account_id, g as DEFAULT_ACCOUNT_ID, i as buildAgentPeerSessionKey, l as normalizeAgentId, n as DEFAULT_MAIN_KEY, p as sanitizeAgentId, r as buildAgentMainSessionKey, s as init_session_key, v as normalizeAccountId, y as normalizeOptionalAccountId } from "./session-key-BSZsryCD.js";
import { a as init_types_secrets, c as normalizeResolvedSecretInputString, t as DEFAULT_SECRET_PROVIDER_ALIAS } from "./types.secrets-Br5ssFsN.js";
import { t as formatCliCommand } from "./command-format-ZZqKRRhR.js";
import { d as init_home_dir, u as expandHomePrefix } from "./paths-CbmqEZIn.js";
import { g as init_globals, n as init_subsystem, t as createSubsystemLogger, v as logVerbose, x as shouldLogVerbose } from "./subsystem-CsPxmH8p.js";
import { _ as resolveUserPath, l as init_utils } from "./utils-CMc9mmF8.js";
import { n as resolveFetch, t as init_fetch } from "./fetch-BgkAjqxB.js";
import { n as resolveRetryConfig, r as retryAsync, t as init_retry } from "./retry-CgLvWye-.js";
import { i as writeJsonAtomic, n as init_json_files } from "./json-files-BSTIUY71.js";
import { K as openVerifiedFileSync, l as resolveDefaultAgentId } from "./agent-scope-CM8plEdu.js";
import { t as logDebug } from "./logger-C833gw0R.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import crypto from "node:crypto";
//#region src/channels/plugins/setup-helpers.ts
init_session_key();
function channelHasAccounts(cfg, channelKey) {
	const base = cfg.channels?.[channelKey];
	return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}
function shouldStoreNameInAccounts(params) {
	if (params.alwaysUseAccounts) return true;
	if (params.accountId !== "default") return true;
	return channelHasAccounts(params.cfg, params.channelKey);
}
function applyAccountNameToChannelSection(params) {
	const trimmed = params.name?.trim();
	if (!trimmed) return params.cfg;
	const accountId = normalizeAccountId(params.accountId);
	const baseConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!shouldStoreNameInAccounts({
		cfg: params.cfg,
		channelKey: params.channelKey,
		accountId,
		alwaysUseAccounts: params.alwaysUseAccounts
	}) && accountId === "default") {
		const safeBase = base ?? {};
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.channelKey]: {
					...safeBase,
					name: trimmed
				}
			}
		};
	}
	const baseAccounts = base?.accounts ?? {};
	const existingAccount = baseAccounts[accountId] ?? {};
	const baseWithoutName = accountId === "default" ? (({ name: _ignored, ...rest }) => rest)(base ?? {}) : base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...baseWithoutName,
				accounts: {
					...baseAccounts,
					[accountId]: {
						...existingAccount,
						name: trimmed
					}
				}
			}
		}
	};
}
function migrateBaseNameToDefaultAccount(params) {
	if (params.alwaysUseAccounts) return params.cfg;
	const base = params.cfg.channels?.[params.channelKey];
	const baseName = base?.name?.trim();
	if (!baseName) return params.cfg;
	const accounts = { ...base?.accounts };
	const defaultAccount = accounts["default"] ?? {};
	if (!defaultAccount.name) accounts[DEFAULT_ACCOUNT_ID] = {
		...defaultAccount,
		name: baseName
	};
	const { name: _ignored, ...rest } = base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...rest,
				accounts
			}
		}
	};
}
function applySetupAccountConfigPatch(params) {
	return patchScopedAccountConfig({
		cfg: params.cfg,
		channelKey: params.channelKey,
		accountId: params.accountId,
		patch: params.patch
	});
}
function patchScopedAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const channelConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof channelConfig === "object" && channelConfig ? channelConfig : void 0;
	const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
	const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
	const patch = params.patch;
	const accountPatch = params.accountPatch ?? patch;
	if (accountId === "default") return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				...patch
			}
		}
	};
	const accounts = base?.accounts ?? {};
	const existingAccount = accounts[accountId] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				accounts: {
					...accounts,
					[accountId]: {
						...existingAccount,
						...ensureAccountEnabled ? { enabled: typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true } : {},
						...accountPatch
					}
				}
			}
		}
	};
}
const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
	"name",
	"token",
	"tokenFile",
	"botToken",
	"appToken",
	"account",
	"signalNumber",
	"authDir",
	"cliPath",
	"dbPath",
	"httpUrl",
	"httpHost",
	"httpPort",
	"webhookPath",
	"webhookUrl",
	"webhookSecret",
	"service",
	"region",
	"homeserver",
	"userId",
	"accessToken",
	"password",
	"deviceName",
	"url",
	"code",
	"dmPolicy",
	"allowFrom",
	"groupPolicy",
	"groupAllowFrom",
	"defaultTo"
]);
const SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL = { telegram: new Set(["streaming"]) };
function shouldMoveSingleAccountChannelKey(params) {
	if (COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(params.key)) return true;
	return SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL[params.channelKey]?.has(params.key) ?? false;
}
function cloneIfObject(value) {
	if (value && typeof value === "object") return structuredClone(value);
	return value;
}
function moveSingleAccountChannelSectionToDefaultAccount(params) {
	const baseConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!base) return params.cfg;
	const accounts = base.accounts ?? {};
	if (Object.keys(accounts).length > 0) return params.cfg;
	const keysToMove = Object.entries(base).filter(([key, value]) => key !== "accounts" && key !== "enabled" && value !== void 0 && shouldMoveSingleAccountChannelKey({
		channelKey: params.channelKey,
		key
	})).map(([key]) => key);
	const defaultAccount = {};
	for (const key of keysToMove) {
		const value = base[key];
		defaultAccount[key] = cloneIfObject(value);
	}
	const nextChannel = { ...base };
	for (const key of keysToMove) delete nextChannel[key];
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...nextChannel,
				accounts: {
					...accounts,
					[DEFAULT_ACCOUNT_ID]: defaultAccount
				}
			}
		}
	};
}
//#endregion
//#region src/infra/exec-safety.ts
const SHELL_METACHARS = /[;&|`$<>]/;
const CONTROL_CHARS = /[\r\n]/;
const QUOTE_CHARS = /["']/;
const BARE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/;
function isLikelyPath(value) {
	if (value.startsWith(".") || value.startsWith("~")) return true;
	if (value.includes("/") || value.includes("\\")) return true;
	return /^[A-Za-z]:[\\/]/.test(value);
}
function isSafeExecutableValue(value) {
	if (!value) return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed.includes("\0")) return false;
	if (CONTROL_CHARS.test(trimmed)) return false;
	if (SHELL_METACHARS.test(trimmed)) return false;
	if (QUOTE_CHARS.test(trimmed)) return false;
	if (isLikelyPath(trimmed)) return true;
	if (trimmed.startsWith("-")) return false;
	return BARE_NAME_PATTERN.test(trimmed);
}
//#endregion
//#region src/secrets/ref-contract.ts
init_types_secrets();
const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
const SECRET_PROVIDER_ALIAS_PATTERN$1 = /^[a-z][a-z0-9_-]{0,63}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SINGLE_VALUE_FILE_REF_ID = "value";
const FILE_SECRET_REF_ID_PATTERN = /^(?:value|\/(?:[^~]|~0|~1)*(?:\/(?:[^~]|~0|~1)*)*)$/;
const EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN = "^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$";
function secretRefKey(ref) {
	return `${ref.source}:${ref.provider}:${ref.id}`;
}
function resolveDefaultSecretProviderAlias(config, source, options) {
	const configured = source === "env" ? config.secrets?.defaults?.env : source === "file" ? config.secrets?.defaults?.file : config.secrets?.defaults?.exec;
	if (configured?.trim()) return configured.trim();
	if (options?.preferFirstProviderForSource) {
		const providers = config.secrets?.providers;
		if (providers) {
			for (const [providerName, provider] of Object.entries(providers)) if (provider?.source === source) return providerName;
		}
	}
	return DEFAULT_SECRET_PROVIDER_ALIAS;
}
function isValidFileSecretRefId(value) {
	if (value === "value") return true;
	if (!value.startsWith("/")) return false;
	return value.slice(1).split("/").every((segment) => FILE_SECRET_REF_SEGMENT_PATTERN.test(segment));
}
function validateExecSecretRefId(value) {
	if (!EXEC_SECRET_REF_ID_PATTERN.test(value)) return {
		ok: false,
		reason: "pattern"
	};
	for (const segment of value.split("/")) if (segment === "." || segment === "..") return {
		ok: false,
		reason: "traversal-segment"
	};
	return { ok: true };
}
function isValidExecSecretRefId(value) {
	return validateExecSecretRefId(value).ok;
}
function formatExecSecretRefIdValidationMessage() {
	return [
		"Exec secret reference id must match /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/",
		"and must not include \".\" or \"..\" path segments",
		"(example: \"vault/openai/api-key\")."
	].join(" ");
}
//#endregion
//#region src/config/types.models.ts
const MODEL_APIS = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"github-copilot",
	"bedrock-converse-stream",
	"ollama"
];
//#endregion
//#region src/config/zod-schema.allowdeny.ts
const AllowDenyActionSchema = z.union([z.literal("allow"), z.literal("deny")]);
const AllowDenyChatTypeSchema = z.union([
	z.literal("direct"),
	z.literal("group"),
	z.literal("channel"),
	z.literal("dm")
]).optional();
function createAllowDenyChannelRulesSchema() {
	return z.object({
		default: AllowDenyActionSchema.optional(),
		rules: z.array(z.object({
			action: AllowDenyActionSchema,
			match: z.object({
				channel: z.string().optional(),
				chatType: AllowDenyChatTypeSchema,
				keyPrefix: z.string().optional(),
				rawKeyPrefix: z.string().optional()
			}).strict().optional()
		}).strict()).optional()
	}).strict().optional();
}
//#endregion
//#region src/config/zod-schema.sensitive.ts
const sensitive = z.registry();
//#endregion
//#region src/config/zod-schema.core.ts
const ENV_SECRET_REF_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
function isAbsolutePath(value) {
	return path.isAbsolute(value) || WINDOWS_ABS_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}
const EnvSecretRefSchema = z.object({
	source: z.literal("env"),
	provider: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\")."),
	id: z.string().regex(ENV_SECRET_REF_ID_PATTERN, "Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: \"OPENAI_API_KEY\").")
}).strict();
const FileSecretRefSchema = z.object({
	source: z.literal("file"),
	provider: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\")."),
	id: z.string().refine(isValidFileSecretRefId, "File secret reference id must be an absolute JSON pointer (example: \"/providers/openai/apiKey\"), or \"value\" for singleValue mode.")
}).strict();
const ExecSecretRefSchema = z.object({
	source: z.literal("exec"),
	provider: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\")."),
	id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage())
}).strict();
const SecretRefSchema = z.discriminatedUnion("source", [
	EnvSecretRefSchema,
	FileSecretRefSchema,
	ExecSecretRefSchema
]);
const SecretInputSchema = z.union([z.string(), SecretRefSchema]);
const SecretsEnvProviderSchema = z.object({
	source: z.literal("env"),
	allowlist: z.array(z.string().regex(ENV_SECRET_REF_ID_PATTERN)).max(256).optional()
}).strict();
const SecretsFileProviderSchema = z.object({
	source: z.literal("file"),
	path: z.string().min(1),
	mode: z.union([z.literal("singleValue"), z.literal("json")]).optional(),
	timeoutMs: z.number().int().positive().max(12e4).optional(),
	maxBytes: z.number().int().positive().max(20 * 1024 * 1024).optional()
}).strict();
const SecretsExecProviderSchema = z.object({
	source: z.literal("exec"),
	command: z.string().min(1).refine((value) => isSafeExecutableValue(value), "secrets.providers.*.command is unsafe.").refine((value) => isAbsolutePath(value), "secrets.providers.*.command must be an absolute path."),
	args: z.array(z.string().max(1024)).max(128).optional(),
	timeoutMs: z.number().int().positive().max(12e4).optional(),
	noOutputTimeoutMs: z.number().int().positive().max(12e4).optional(),
	maxOutputBytes: z.number().int().positive().max(20 * 1024 * 1024).optional(),
	jsonOnly: z.boolean().optional(),
	env: z.record(z.string(), z.string()).optional(),
	passEnv: z.array(z.string().regex(ENV_SECRET_REF_ID_PATTERN)).max(128).optional(),
	trustedDirs: z.array(z.string().min(1).refine((value) => isAbsolutePath(value), "trustedDirs entries must be absolute paths.")).max(64).optional(),
	allowInsecurePath: z.boolean().optional(),
	allowSymlinkCommand: z.boolean().optional()
}).strict();
const SecretProviderSchema = z.discriminatedUnion("source", [
	SecretsEnvProviderSchema,
	SecretsFileProviderSchema,
	SecretsExecProviderSchema
]);
const SecretsConfigSchema = z.object({
	providers: z.object({}).catchall(SecretProviderSchema).optional(),
	defaults: z.object({
		env: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
		file: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
		exec: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional()
	}).strict().optional(),
	resolution: z.object({
		maxProviderConcurrency: z.number().int().positive().max(16).optional(),
		maxRefsPerProvider: z.number().int().positive().max(4096).optional(),
		maxBatchBytes: z.number().int().positive().max(5 * 1024 * 1024).optional()
	}).strict().optional()
}).strict().optional();
const ModelApiSchema = z.enum(MODEL_APIS);
const ModelCompatSchema = z.object({
	supportsStore: z.boolean().optional(),
	supportsDeveloperRole: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
	supportsUsageInStreaming: z.boolean().optional(),
	supportsTools: z.boolean().optional(),
	supportsStrictMode: z.boolean().optional(),
	maxTokensField: z.union([z.literal("max_completion_tokens"), z.literal("max_tokens")]).optional(),
	thinkingFormat: z.union([
		z.literal("openai"),
		z.literal("zai"),
		z.literal("qwen")
	]).optional(),
	requiresToolResultName: z.boolean().optional(),
	requiresAssistantAfterToolResult: z.boolean().optional(),
	requiresThinkingAsText: z.boolean().optional(),
	requiresMistralToolIds: z.boolean().optional(),
	requiresOpenAiAnthropicToolPayload: z.boolean().optional()
}).strict().optional();
const ModelDefinitionSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	api: ModelApiSchema.optional(),
	reasoning: z.boolean().optional(),
	input: z.array(z.union([z.literal("text"), z.literal("image")])).optional(),
	cost: z.object({
		input: z.number().optional(),
		output: z.number().optional(),
		cacheRead: z.number().optional(),
		cacheWrite: z.number().optional()
	}).strict().optional(),
	contextWindow: z.number().positive().optional(),
	maxTokens: z.number().positive().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	compat: ModelCompatSchema
}).strict();
const ModelProviderSchema = z.object({
	baseUrl: z.string().min(1),
	apiKey: SecretInputSchema.optional().register(sensitive),
	auth: z.union([
		z.literal("api-key"),
		z.literal("aws-sdk"),
		z.literal("oauth"),
		z.literal("token")
	]).optional(),
	api: ModelApiSchema.optional(),
	injectNumCtxForOpenAICompat: z.boolean().optional(),
	headers: z.record(z.string(), SecretInputSchema.register(sensitive)).optional(),
	authHeader: z.boolean().optional(),
	models: z.array(ModelDefinitionSchema)
}).strict();
const BedrockDiscoverySchema = z.object({
	enabled: z.boolean().optional(),
	region: z.string().optional(),
	providerFilter: z.array(z.string()).optional(),
	refreshInterval: z.number().int().nonnegative().optional(),
	defaultContextWindow: z.number().int().positive().optional(),
	defaultMaxTokens: z.number().int().positive().optional()
}).strict().optional();
const ModelsConfigSchema = z.object({
	mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
	providers: z.record(z.string(), ModelProviderSchema).optional(),
	bedrockDiscovery: BedrockDiscoverySchema
}).strict().optional();
const GroupChatSchema = z.object({
	mentionPatterns: z.array(z.string()).optional(),
	historyLimit: z.number().int().positive().optional()
}).strict().optional();
const DmConfigSchema = z.object({ historyLimit: z.number().int().min(0).optional() }).strict();
const IdentitySchema = z.object({
	name: z.string().optional(),
	theme: z.string().optional(),
	emoji: z.string().optional(),
	avatar: z.string().optional()
}).strict().optional();
const QueueModeSchema = z.union([
	z.literal("steer"),
	z.literal("followup"),
	z.literal("collect"),
	z.literal("steer-backlog"),
	z.literal("steer+backlog"),
	z.literal("queue"),
	z.literal("interrupt")
]);
const QueueDropSchema = z.union([
	z.literal("old"),
	z.literal("new"),
	z.literal("summarize")
]);
const ReplyToModeSchema = z.union([
	z.literal("off"),
	z.literal("first"),
	z.literal("all")
]);
const TypingModeSchema = z.union([
	z.literal("never"),
	z.literal("instant"),
	z.literal("thinking"),
	z.literal("message")
]);
const GroupPolicySchema = z.enum([
	"open",
	"disabled",
	"allowlist"
]);
const DmPolicySchema = z.enum([
	"pairing",
	"allowlist",
	"open",
	"disabled"
]);
const BlockStreamingCoalesceSchema = z.object({
	minChars: z.number().int().positive().optional(),
	maxChars: z.number().int().positive().optional(),
	idleMs: z.number().int().nonnegative().optional()
}).strict();
const ReplyRuntimeConfigSchemaShape = {
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	responsePrefix: z.string().optional(),
	mediaMaxMb: z.number().positive().optional()
};
const BlockStreamingChunkSchema = z.object({
	minChars: z.number().int().positive().optional(),
	maxChars: z.number().int().positive().optional(),
	breakPreference: z.union([
		z.literal("paragraph"),
		z.literal("newline"),
		z.literal("sentence")
	]).optional()
}).strict();
const MarkdownTableModeSchema = z.enum([
	"off",
	"bullets",
	"code"
]);
const MarkdownConfigSchema = z.object({ tables: MarkdownTableModeSchema.optional() }).strict().optional();
const TtsProviderSchema = z.enum([
	"elevenlabs",
	"openai",
	"edge"
]);
const TtsModeSchema = z.enum(["final", "all"]);
const TtsAutoSchema = z.enum([
	"off",
	"always",
	"inbound",
	"tagged"
]);
const TtsConfigSchema = z.object({
	auto: TtsAutoSchema.optional(),
	enabled: z.boolean().optional(),
	mode: TtsModeSchema.optional(),
	provider: TtsProviderSchema.optional(),
	summaryModel: z.string().optional(),
	modelOverrides: z.object({
		enabled: z.boolean().optional(),
		allowText: z.boolean().optional(),
		allowProvider: z.boolean().optional(),
		allowVoice: z.boolean().optional(),
		allowModelId: z.boolean().optional(),
		allowVoiceSettings: z.boolean().optional(),
		allowNormalization: z.boolean().optional(),
		allowSeed: z.boolean().optional()
	}).strict().optional(),
	elevenlabs: z.object({
		apiKey: SecretInputSchema.optional().register(sensitive),
		baseUrl: z.string().optional(),
		voiceId: z.string().optional(),
		modelId: z.string().optional(),
		seed: z.number().int().min(0).max(4294967295).optional(),
		applyTextNormalization: z.enum([
			"auto",
			"on",
			"off"
		]).optional(),
		languageCode: z.string().optional(),
		voiceSettings: z.object({
			stability: z.number().min(0).max(1).optional(),
			similarityBoost: z.number().min(0).max(1).optional(),
			style: z.number().min(0).max(1).optional(),
			useSpeakerBoost: z.boolean().optional(),
			speed: z.number().min(.5).max(2).optional()
		}).strict().optional()
	}).strict().optional(),
	openai: z.object({
		apiKey: SecretInputSchema.optional().register(sensitive),
		baseUrl: z.string().optional(),
		model: z.string().optional(),
		voice: z.string().optional(),
		speed: z.number().min(.25).max(4).optional(),
		instructions: z.string().optional()
	}).strict().optional(),
	edge: z.object({
		enabled: z.boolean().optional(),
		voice: z.string().optional(),
		lang: z.string().optional(),
		outputFormat: z.string().optional(),
		pitch: z.string().optional(),
		rate: z.string().optional(),
		volume: z.string().optional(),
		saveSubtitles: z.boolean().optional(),
		proxy: z.string().optional(),
		timeoutMs: z.number().int().min(1e3).max(12e4).optional()
	}).strict().optional(),
	prefsPath: z.string().optional(),
	maxTextLength: z.number().int().min(1).optional(),
	timeoutMs: z.number().int().min(1e3).max(12e4).optional()
}).strict().optional();
const HumanDelaySchema = z.object({
	mode: z.union([
		z.literal("off"),
		z.literal("natural"),
		z.literal("custom")
	]).optional(),
	minMs: z.number().int().nonnegative().optional(),
	maxMs: z.number().int().nonnegative().optional()
}).strict();
const CliBackendWatchdogModeSchema = z.object({
	noOutputTimeoutMs: z.number().int().min(1e3).optional(),
	noOutputTimeoutRatio: z.number().min(.05).max(.95).optional(),
	minMs: z.number().int().min(1e3).optional(),
	maxMs: z.number().int().min(1e3).optional()
}).strict().optional();
const CliBackendSchema = z.object({
	command: z.string(),
	args: z.array(z.string()).optional(),
	output: z.union([
		z.literal("json"),
		z.literal("text"),
		z.literal("jsonl")
	]).optional(),
	resumeOutput: z.union([
		z.literal("json"),
		z.literal("text"),
		z.literal("jsonl")
	]).optional(),
	input: z.union([z.literal("arg"), z.literal("stdin")]).optional(),
	maxPromptArgChars: z.number().int().positive().optional(),
	env: z.record(z.string(), z.string()).optional(),
	clearEnv: z.array(z.string()).optional(),
	modelArg: z.string().optional(),
	modelAliases: z.record(z.string(), z.string()).optional(),
	sessionArg: z.string().optional(),
	sessionArgs: z.array(z.string()).optional(),
	resumeArgs: z.array(z.string()).optional(),
	sessionMode: z.union([
		z.literal("always"),
		z.literal("existing"),
		z.literal("none")
	]).optional(),
	sessionIdFields: z.array(z.string()).optional(),
	systemPromptArg: z.string().optional(),
	systemPromptMode: z.union([z.literal("append"), z.literal("replace")]).optional(),
	systemPromptWhen: z.union([
		z.literal("first"),
		z.literal("always"),
		z.literal("never")
	]).optional(),
	imageArg: z.string().optional(),
	imageMode: z.union([z.literal("repeat"), z.literal("list")]).optional(),
	serialize: z.boolean().optional(),
	reliability: z.object({ watchdog: z.object({
		fresh: CliBackendWatchdogModeSchema,
		resume: CliBackendWatchdogModeSchema
	}).strict().optional() }).strict().optional()
}).strict();
const normalizeAllowFrom = (values) => (values ?? []).map((v) => String(v).trim()).filter(Boolean);
const requireOpenAllowFrom = (params) => {
	if (params.policy !== "open") return;
	if (normalizeAllowFrom(params.allowFrom).includes("*")) return;
	params.ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: params.path,
		message: params.message
	});
};
/**
* Validate that dmPolicy="allowlist" has a non-empty allowFrom array.
* Without this, all DMs are silently dropped because the allowlist is empty
* and no senders can match.
*/
const requireAllowlistAllowFrom = (params) => {
	if (params.policy !== "allowlist") return;
	if (normalizeAllowFrom(params.allowFrom).length > 0) return;
	params.ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: params.path,
		message: params.message
	});
};
const MSTeamsReplyStyleSchema = z.enum(["thread", "top-level"]);
const RetryConfigSchema = z.object({
	attempts: z.number().int().min(1).optional(),
	minDelayMs: z.number().int().min(0).optional(),
	maxDelayMs: z.number().int().min(0).optional(),
	jitter: z.number().min(0).max(1).optional()
}).strict().optional();
const QueueModeBySurfaceSchema = z.object({
	whatsapp: QueueModeSchema.optional(),
	telegram: QueueModeSchema.optional(),
	discord: QueueModeSchema.optional(),
	irc: QueueModeSchema.optional(),
	slack: QueueModeSchema.optional(),
	mattermost: QueueModeSchema.optional(),
	signal: QueueModeSchema.optional(),
	imessage: QueueModeSchema.optional(),
	msteams: QueueModeSchema.optional(),
	webchat: QueueModeSchema.optional()
}).strict().optional();
const DebounceMsBySurfaceSchema = z.record(z.string(), z.number().int().nonnegative()).optional();
const QueueSchema = z.object({
	mode: QueueModeSchema.optional(),
	byChannel: QueueModeBySurfaceSchema,
	debounceMs: z.number().int().nonnegative().optional(),
	debounceMsByChannel: DebounceMsBySurfaceSchema,
	cap: z.number().int().positive().optional(),
	drop: QueueDropSchema.optional()
}).strict().optional();
const InboundDebounceSchema = z.object({
	debounceMs: z.number().int().nonnegative().optional(),
	byChannel: DebounceMsBySurfaceSchema
}).strict().optional();
const TranscribeAudioSchema = z.object({
	command: z.array(z.string()).superRefine((value, ctx) => {
		const executable = value[0];
		if (!isSafeExecutableValue(executable)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: [0],
			message: "expected safe executable name or path"
		});
	}),
	timeoutSeconds: z.number().int().positive().optional()
}).strict().optional();
const HexColorSchema = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");
const ExecutableTokenSchema = z.string().refine(isSafeExecutableValue, "expected safe executable name or path");
const MediaUnderstandingScopeSchema = createAllowDenyChannelRulesSchema();
const MediaUnderstandingCapabilitiesSchema = z.array(z.union([
	z.literal("image"),
	z.literal("audio"),
	z.literal("video")
])).optional();
const MediaUnderstandingAttachmentsSchema = z.object({
	mode: z.union([z.literal("first"), z.literal("all")]).optional(),
	maxAttachments: z.number().int().positive().optional(),
	prefer: z.union([
		z.literal("first"),
		z.literal("last"),
		z.literal("path"),
		z.literal("url")
	]).optional()
}).strict().optional();
const DeepgramAudioSchema = z.object({
	detectLanguage: z.boolean().optional(),
	punctuate: z.boolean().optional(),
	smartFormat: z.boolean().optional()
}).strict().optional();
const ProviderOptionValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean()
]);
const ProviderOptionsSchema = z.record(z.string(), z.record(z.string(), ProviderOptionValueSchema)).optional();
const MediaUnderstandingRuntimeFields = {
	prompt: z.string().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	language: z.string().optional(),
	providerOptions: ProviderOptionsSchema,
	deepgram: DeepgramAudioSchema,
	baseUrl: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional()
};
const MediaUnderstandingModelSchema = z.object({
	provider: z.string().optional(),
	model: z.string().optional(),
	capabilities: MediaUnderstandingCapabilitiesSchema,
	type: z.union([z.literal("provider"), z.literal("cli")]).optional(),
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	maxChars: z.number().int().positive().optional(),
	maxBytes: z.number().int().positive().optional(),
	...MediaUnderstandingRuntimeFields,
	profile: z.string().optional(),
	preferredProfile: z.string().optional()
}).strict().optional();
const ToolsMediaUnderstandingSchema = z.object({
	enabled: z.boolean().optional(),
	scope: MediaUnderstandingScopeSchema,
	maxBytes: z.number().int().positive().optional(),
	maxChars: z.number().int().positive().optional(),
	...MediaUnderstandingRuntimeFields,
	attachments: MediaUnderstandingAttachmentsSchema,
	models: z.array(MediaUnderstandingModelSchema).optional(),
	echoTranscript: z.boolean().optional(),
	echoFormat: z.string().optional()
}).strict().optional();
const ToolsMediaSchema = z.object({
	models: z.array(MediaUnderstandingModelSchema).optional(),
	concurrency: z.number().int().positive().optional(),
	image: ToolsMediaUnderstandingSchema.optional(),
	audio: ToolsMediaUnderstandingSchema.optional(),
	video: ToolsMediaUnderstandingSchema.optional()
}).strict().optional();
const LinkModelSchema = z.object({
	type: z.literal("cli").optional(),
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	timeoutSeconds: z.number().int().positive().optional()
}).strict();
const ToolsLinksSchema = z.object({
	enabled: z.boolean().optional(),
	scope: MediaUnderstandingScopeSchema,
	maxLinks: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	models: z.array(LinkModelSchema).optional()
}).strict().optional();
const NativeCommandsSettingSchema = z.union([z.boolean(), z.literal("auto")]);
const ProviderCommandsSchema = z.object({
	native: NativeCommandsSettingSchema.optional(),
	nativeSkills: NativeCommandsSettingSchema.optional()
}).strict().optional();
//#endregion
//#region src/channels/plugins/config-schema.ts
const AllowFromEntrySchema = z.union([z.string(), z.number()]);
const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();
function buildNestedDmConfigSchema() {
	return z.object({
		enabled: z.boolean().optional(),
		policy: DmPolicySchema.optional(),
		allowFrom: AllowFromListSchema
	}).optional();
}
function buildCatchallMultiAccountChannelSchema(accountSchema) {
	return accountSchema.extend({
		accounts: z.object({}).catchall(accountSchema).optional(),
		defaultAccount: z.string().optional()
	});
}
function buildChannelConfigSchema(schema) {
	const schemaWithJson = schema;
	if (typeof schemaWithJson.toJSONSchema === "function") return { schema: schemaWithJson.toJSONSchema({
		target: "draft-07",
		unrepresentable: "any"
	}) };
	return { schema: {
		type: "object",
		additionalProperties: true
	} };
}
//#endregion
//#region src/channels/plugins/config-helpers.ts
init_session_key();
function isConfiguredSecretValue(value) {
	if (typeof value === "string") return value.trim().length > 0;
	return Boolean(value);
}
function setAccountEnabledInConfigSection(params) {
	const accountKey = params.accountId || "default";
	const base = params.cfg.channels?.[params.sectionKey];
	const hasAccounts = Boolean(base?.accounts);
	if (params.allowTopLevel && accountKey === "default" && !hasAccounts) return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.sectionKey]: {
				...base,
				enabled: params.enabled
			}
		}
	};
	const baseAccounts = base?.accounts ?? {};
	const existing = baseAccounts[accountKey] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.sectionKey]: {
				...base,
				accounts: {
					...baseAccounts,
					[accountKey]: {
						...existing,
						enabled: params.enabled
					}
				}
			}
		}
	};
}
function deleteAccountFromConfigSection(params) {
	const accountKey = params.accountId || "default";
	const base = params.cfg.channels?.[params.sectionKey];
	if (!base) return params.cfg;
	const baseAccounts = base.accounts && typeof base.accounts === "object" ? { ...base.accounts } : void 0;
	if (accountKey !== "default") {
		const accounts = baseAccounts ? { ...baseAccounts } : {};
		delete accounts[accountKey];
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.sectionKey]: {
					...base,
					accounts: Object.keys(accounts).length ? accounts : void 0
				}
			}
		};
	}
	if (baseAccounts && Object.keys(baseAccounts).length > 0) {
		delete baseAccounts[accountKey];
		const baseRecord = { ...base };
		for (const field of params.clearBaseFields ?? []) if (field in baseRecord) baseRecord[field] = void 0;
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.sectionKey]: {
					...baseRecord,
					accounts: Object.keys(baseAccounts).length ? baseAccounts : void 0
				}
			}
		};
	}
	const nextChannels = { ...params.cfg.channels };
	delete nextChannels[params.sectionKey];
	const nextCfg = { ...params.cfg };
	if (Object.keys(nextChannels).length > 0) nextCfg.channels = nextChannels;
	else delete nextCfg.channels;
	return nextCfg;
}
function clearAccountEntryFields(params) {
	const accountKey = params.accountId || "default";
	const baseAccounts = params.accounts && typeof params.accounts === "object" ? { ...params.accounts } : void 0;
	if (!baseAccounts || !(accountKey in baseAccounts)) return {
		nextAccounts: baseAccounts,
		changed: false,
		cleared: false
	};
	const entry = baseAccounts[accountKey];
	if (!entry || typeof entry !== "object") return {
		nextAccounts: baseAccounts,
		changed: false,
		cleared: false
	};
	const nextEntry = { ...entry };
	if (!params.fields.some((field) => field in nextEntry)) return {
		nextAccounts: baseAccounts,
		changed: false,
		cleared: false
	};
	const isValueSet = params.isValueSet ?? isConfiguredSecretValue;
	let cleared = Boolean(params.markClearedOnFieldPresence);
	for (const field of params.fields) {
		if (!(field in nextEntry)) continue;
		if (isValueSet(nextEntry[field])) cleared = true;
		delete nextEntry[field];
	}
	if (Object.keys(nextEntry).length === 0) delete baseAccounts[accountKey];
	else baseAccounts[accountKey] = nextEntry;
	return {
		nextAccounts: Object.keys(baseAccounts).length > 0 ? baseAccounts : void 0,
		changed: true,
		cleared
	};
}
//#endregion
//#region src/channels/plugins/helpers.ts
init_session_key();
function formatPairingApproveHint(channelId) {
	return `Approve via: ${formatCliCommand(`openclaw pairing list ${channelId}`)} / ${formatCliCommand(`openclaw pairing approve ${channelId} <code>`)}`;
}
function parseOptionalDelimitedEntries(value) {
	if (!value?.trim()) return;
	const parsed = value.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
	return parsed.length > 0 ? parsed : void 0;
}
function buildAccountScopedDmSecurityPolicy(params) {
	const resolvedAccountId = params.accountId ?? params.fallbackAccountId ?? "default";
	const channelConfig = params.cfg.channels?.[params.channelKey];
	const basePath = Boolean(channelConfig?.accounts?.[resolvedAccountId]) ? `channels.${params.channelKey}.accounts.${resolvedAccountId}.` : `channels.${params.channelKey}.`;
	const allowFromPath = `${basePath}${params.allowFromPathSuffix ?? ""}`;
	const policyPath = params.policyPathSuffix != null ? `${basePath}${params.policyPathSuffix}` : void 0;
	return {
		policy: params.policy ?? params.defaultPolicy ?? "pairing",
		allowFrom: params.allowFrom ?? [],
		policyPath,
		allowFromPath,
		approveHint: params.approveHint ?? formatPairingApproveHint(params.approveChannelId ?? params.channelKey),
		normalizeEntry: params.normalizeEntry
	};
}
//#endregion
//#region src/channels/plugins/pairing-message.ts
const PAIRING_APPROVED_MESSAGE = "✅ OpenClaw access approved. Send a message to start chatting.";
//#endregion
//#region src/plugins/slots.ts
function defaultSlotIdForKey(slotKey) {
	return DEFAULT_SLOT_BY_KEY[slotKey];
}
var DEFAULT_SLOT_BY_KEY;
var init_slots = __esmMin((() => {
	DEFAULT_SLOT_BY_KEY = {
		memory: "memory-core",
		contextEngine: "legacy"
	};
}));
//#endregion
//#region src/context-engine/registry.ts
function getContextEngineRegistryState() {
	const globalState = globalThis;
	if (!globalState[CONTEXT_ENGINE_REGISTRY_STATE]) globalState[CONTEXT_ENGINE_REGISTRY_STATE] = { engines: /* @__PURE__ */ new Map() };
	return globalState[CONTEXT_ENGINE_REGISTRY_STATE];
}
function requireContextEngineOwner(owner) {
	const normalizedOwner = owner.trim();
	if (!normalizedOwner) throw new Error(`registerContextEngineForOwner: owner must be a non-empty string, got ${JSON.stringify(owner)}`);
	return normalizedOwner;
}
/**
* Register a context engine implementation under an explicit trusted owner.
*/
function registerContextEngineForOwner(id, factory, owner, opts) {
	const normalizedOwner = requireContextEngineOwner(owner);
	const registry = getContextEngineRegistryState().engines;
	const existing = registry.get(id);
	if (id === defaultSlotIdForKey("contextEngine") && normalizedOwner !== CORE_CONTEXT_ENGINE_OWNER) return {
		ok: false,
		existingOwner: CORE_CONTEXT_ENGINE_OWNER
	};
	if (existing && existing.owner !== normalizedOwner) return {
		ok: false,
		existingOwner: existing.owner
	};
	if (existing && opts?.allowSameOwnerRefresh !== true) return {
		ok: false,
		existingOwner: existing.owner
	};
	registry.set(id, {
		factory,
		owner: normalizedOwner
	});
	return { ok: true };
}
/**
* List all registered engine ids.
*/
function listContextEngineIds() {
	return [...getContextEngineRegistryState().engines.keys()];
}
/**
* Resolve which ContextEngine to use based on plugin slot configuration.
*
* Resolution order:
*   1. `config.plugins.slots.contextEngine` (explicit slot override)
*   2. Default slot value ("legacy")
*
* Throws if the resolved engine id has no registered factory.
*/
async function resolveContextEngine(config) {
	const slotValue = config?.plugins?.slots?.contextEngine;
	const engineId = typeof slotValue === "string" && slotValue.trim() ? slotValue.trim() : defaultSlotIdForKey("contextEngine");
	const entry = getContextEngineRegistryState().engines.get(engineId);
	if (!entry) throw new Error(`Context engine "${engineId}" is not registered. Available engines: ${listContextEngineIds().join(", ") || "(none)"}`);
	return entry.factory();
}
var CONTEXT_ENGINE_REGISTRY_STATE, CORE_CONTEXT_ENGINE_OWNER;
var init_registry$3 = __esmMin((() => {
	init_slots();
	CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
	CORE_CONTEXT_ENGINE_OWNER = "core";
}));
//#endregion
//#region src/hooks/internal-hooks.ts
/**
* Register a hook handler for a specific event type or event:action combination
*
* @param eventKey - Event type (e.g., 'command') or specific action (e.g., 'command:new')
* @param handler - Function to call when the event is triggered
*
* @example
* ```ts
* // Listen to all command events
* registerInternalHook('command', async (event) => {
*   console.log('Command:', event.action);
* });
*
* // Listen only to /new commands
* registerInternalHook('command:new', async (event) => {
*   await saveSessionToMemory(event);
* });
* ```
*/
function registerInternalHook(eventKey, handler) {
	if (!handlers.has(eventKey)) handlers.set(eventKey, []);
	handlers.get(eventKey).push(handler);
}
/**
* Trigger a hook event
*
* Calls all handlers registered for:
* 1. The general event type (e.g., 'command')
* 2. The specific event:action combination (e.g., 'command:new')
*
* Handlers are called in registration order. Errors are caught and logged
* but don't prevent other handlers from running.
*
* @param event - The event to trigger
*/
async function triggerInternalHook(event) {
	const typeHandlers = handlers.get(event.type) ?? [];
	const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
	const allHandlers = [...typeHandlers, ...specificHandlers];
	if (allHandlers.length === 0) return;
	for (const handler of allHandlers) try {
		await handler(event);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log$1.error(`Hook error [${event.type}:${event.action}]: ${message}`);
	}
}
/**
* Create a hook event with common fields filled in
*
* @param type - The event type
* @param action - The action within that type
* @param sessionKey - The session key
* @param context - Additional context
*/
function createInternalHookEvent(type, action, sessionKey, context = {}) {
	return {
		type,
		action,
		sessionKey,
		context,
		timestamp: /* @__PURE__ */ new Date(),
		messages: []
	};
}
var _g, handlers, log$1;
var init_internal_hooks = __esmMin((() => {
	init_subsystem();
	_g = globalThis;
	handlers = _g.__openclaw_internal_hook_handlers__ ??= /* @__PURE__ */ new Map();
	log$1 = createSubsystemLogger("internal-hooks");
}));
//#endregion
//#region src/channels/targets.ts
function normalizeTargetId(kind, id) {
	return `${kind}:${id}`.toLowerCase();
}
function buildMessagingTarget(kind, id, raw) {
	return {
		kind,
		id,
		raw,
		normalized: normalizeTargetId(kind, id)
	};
}
function ensureTargetId(params) {
	if (!params.pattern.test(params.candidate)) throw new Error(params.errorMessage);
	return params.candidate;
}
function parseTargetMention(params) {
	const match = params.raw.match(params.mentionPattern);
	if (!match?.[1]) return;
	return buildMessagingTarget(params.kind, match[1], params.raw);
}
function parseTargetPrefix(params) {
	if (!params.raw.startsWith(params.prefix)) return;
	const id = params.raw.slice(params.prefix.length).trim();
	return id ? buildMessagingTarget(params.kind, id, params.raw) : void 0;
}
function parseTargetPrefixes(params) {
	for (const entry of params.prefixes) {
		const parsed = parseTargetPrefix({
			raw: params.raw,
			prefix: entry.prefix,
			kind: entry.kind
		});
		if (parsed) return parsed;
	}
}
function parseAtUserTarget(params) {
	if (!params.raw.startsWith("@")) return;
	return buildMessagingTarget("user", ensureTargetId({
		candidate: params.raw.slice(1).trim(),
		pattern: params.pattern,
		errorMessage: params.errorMessage
	}), params.raw);
}
function parseMentionPrefixOrAtUserTarget(params) {
	const mentionTarget = parseTargetMention({
		raw: params.raw,
		mentionPattern: params.mentionPattern,
		kind: "user"
	});
	if (mentionTarget) return mentionTarget;
	const prefixedTarget = parseTargetPrefixes({
		raw: params.raw,
		prefixes: params.prefixes
	});
	if (prefixedTarget) return prefixedTarget;
	return parseAtUserTarget({
		raw: params.raw,
		pattern: params.atUserPattern,
		errorMessage: params.atUserErrorMessage
	});
}
function requireTargetKind(params) {
	const kindLabel = params.kind;
	if (!params.target) throw new Error(`${params.platform} ${kindLabel} id is required.`);
	if (params.target.kind !== params.kind) throw new Error(`${params.platform} ${kindLabel} id is required (use ${kindLabel}:<id>).`);
	return params.target.id;
}
var init_targets$2 = __esmMin((() => {}));
//#endregion
//#region extensions/discord/src/directory-cache.ts
function normalizeAccountCacheKey(accountId) {
	return normalizeAccountId(accountId ?? "default") || "default";
}
function normalizeSnowflake(value) {
	const text = String(value ?? "").trim();
	if (!/^\d+$/.test(text)) return null;
	return text;
}
function normalizeHandleKey(raw) {
	let handle = raw.trim();
	if (!handle) return null;
	if (handle.startsWith("@")) handle = handle.slice(1).trim();
	if (!handle || /\s/.test(handle)) return null;
	return handle.toLowerCase();
}
function ensureAccountCache(accountId) {
	const cacheKey = normalizeAccountCacheKey(accountId);
	const existing = DIRECTORY_HANDLE_CACHE.get(cacheKey);
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	DIRECTORY_HANDLE_CACHE.set(cacheKey, created);
	return created;
}
function setCacheEntry(cache, key, userId) {
	if (cache.has(key)) cache.delete(key);
	cache.set(key, userId);
	if (cache.size <= DISCORD_DIRECTORY_CACHE_MAX_ENTRIES) return;
	const oldest = cache.keys().next();
	if (!oldest.done) cache.delete(oldest.value);
}
function rememberDiscordDirectoryUser(params) {
	const userId = normalizeSnowflake(params.userId);
	if (!userId) return;
	const cache = ensureAccountCache(params.accountId);
	for (const candidate of params.handles) {
		if (typeof candidate !== "string") continue;
		const handle = normalizeHandleKey(candidate);
		if (!handle) continue;
		setCacheEntry(cache, handle, userId);
		const withoutDiscriminator = handle.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
		if (withoutDiscriminator && withoutDiscriminator !== handle) setCacheEntry(cache, withoutDiscriminator, userId);
	}
}
function resolveDiscordDirectoryUserId(params) {
	const cache = DIRECTORY_HANDLE_CACHE.get(normalizeAccountCacheKey(params.accountId));
	if (!cache) return;
	const handle = normalizeHandleKey(params.handle);
	if (!handle) return;
	const direct = cache.get(handle);
	if (direct) return direct;
	const withoutDiscriminator = handle.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
	if (!withoutDiscriminator || withoutDiscriminator === handle) return;
	return cache.get(withoutDiscriminator);
}
var DISCORD_DIRECTORY_CACHE_MAX_ENTRIES, DISCORD_DISCRIMINATOR_SUFFIX, DIRECTORY_HANDLE_CACHE;
var init_directory_cache = __esmMin((() => {
	init_account_id();
	DISCORD_DIRECTORY_CACHE_MAX_ENTRIES = 4e3;
	DISCORD_DISCRIMINATOR_SUFFIX = /#\d{4}$/;
	DIRECTORY_HANDLE_CACHE = /* @__PURE__ */ new Map();
}));
//#endregion
//#region src/channels/plugins/account-action-gate.ts
function createAccountActionGate(params) {
	return (key, defaultValue = true) => {
		const accountValue = params.accountActions?.[key];
		if (accountValue !== void 0) return accountValue;
		const baseValue = params.baseActions?.[key];
		if (baseValue !== void 0) return baseValue;
		return defaultValue;
	};
}
var init_account_action_gate = __esmMin((() => {}));
//#endregion
//#region src/channels/plugins/account-helpers.ts
function createAccountListHelpers(channelKey, options) {
	function resolveConfiguredDefaultAccountId(cfg) {
		const channel = cfg.channels?.[channelKey];
		const preferred = normalizeOptionalAccountId(typeof channel?.defaultAccount === "string" ? channel.defaultAccount : void 0);
		if (!preferred) return;
		if (listAccountIds(cfg).some((id) => normalizeAccountId(id) === preferred)) return preferred;
	}
	function listConfiguredAccountIds(cfg) {
		const accounts = (cfg.channels?.[channelKey])?.accounts;
		if (!accounts || typeof accounts !== "object") return [];
		const ids = Object.keys(accounts).filter(Boolean);
		const normalizeConfiguredAccountId = options?.normalizeAccountId;
		if (!normalizeConfiguredAccountId) return ids;
		return [...new Set(ids.map((id) => normalizeConfiguredAccountId(id)).filter(Boolean))];
	}
	function listAccountIds(cfg) {
		const ids = listConfiguredAccountIds(cfg);
		if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
		return ids.toSorted((a, b) => a.localeCompare(b));
	}
	function resolveDefaultAccountId(cfg) {
		const preferred = resolveConfiguredDefaultAccountId(cfg);
		if (preferred) return preferred;
		const ids = listAccountIds(cfg);
		if (ids.includes("default")) return DEFAULT_ACCOUNT_ID;
		return ids[0] ?? "default";
	}
	return {
		listConfiguredAccountIds,
		listAccountIds,
		resolveDefaultAccountId
	};
}
var init_account_helpers = __esmMin((() => {
	init_session_key();
}));
//#endregion
//#region src/routing/account-lookup.ts
function resolveAccountEntry(accounts, accountId) {
	if (!accounts || typeof accounts !== "object") return;
	if (Object.hasOwn(accounts, accountId)) return accounts[accountId];
	const normalized = accountId.toLowerCase();
	const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized);
	return matchKey ? accounts[matchKey] : void 0;
}
var init_account_lookup = __esmMin((() => {}));
//#endregion
//#region extensions/discord/src/token.ts
function normalizeDiscordToken(raw, path) {
	const trimmed = normalizeResolvedSecretInputString({
		value: raw,
		path
	});
	if (!trimmed) return;
	return trimmed.replace(/^Bot\s+/i, "");
}
function resolveDiscordToken(cfg, opts = {}) {
	const accountId = normalizeAccountId(opts.accountId);
	const discordCfg = cfg?.channels?.discord;
	const resolveAccountCfg = (id) => {
		const accounts = discordCfg?.accounts;
		if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return;
		const direct = accounts[id];
		if (direct) return direct;
		const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === id);
		return matchKey ? accounts[matchKey] : void 0;
	};
	const accountCfg = resolveAccountCfg(accountId);
	const hasAccountToken = Boolean(accountCfg && Object.prototype.hasOwnProperty.call(accountCfg, "token"));
	const accountToken = normalizeDiscordToken(accountCfg?.token ?? void 0, `channels.discord.accounts.${accountId}.token`);
	if (accountToken) return {
		token: accountToken,
		source: "config"
	};
	if (hasAccountToken) return {
		token: "",
		source: "none"
	};
	const configToken = normalizeDiscordToken(discordCfg?.token ?? void 0, "channels.discord.token");
	if (configToken) return {
		token: configToken,
		source: "config"
	};
	const envToken = accountId === "default" ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN") : void 0;
	if (envToken) return {
		token: envToken,
		source: "env"
	};
	return {
		token: "",
		source: "none"
	};
}
var init_token = __esmMin((() => {
	init_types_secrets();
	init_session_key();
}));
//#endregion
//#region extensions/discord/src/accounts.ts
function resolveDiscordAccountConfig(cfg, accountId) {
	return resolveAccountEntry(cfg.channels?.discord?.accounts, accountId);
}
function mergeDiscordAccountConfig(cfg, accountId) {
	const { accounts: _ignored, ...base } = cfg.channels?.discord ?? {};
	const account = resolveDiscordAccountConfig(cfg, accountId) ?? {};
	return {
		...base,
		...account
	};
}
function createDiscordActionGate(params) {
	const accountId = normalizeAccountId(params.accountId);
	return createAccountActionGate({
		baseActions: params.cfg.channels?.discord?.actions,
		accountActions: resolveDiscordAccountConfig(params.cfg, accountId)?.actions
	});
}
function resolveDiscordAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
	const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
	const merged = mergeDiscordAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
	return {
		accountId,
		enabled,
		name: merged.name?.trim() || void 0,
		token: tokenResolution.token,
		tokenSource: tokenResolution.source,
		config: merged
	};
}
function resolveDiscordMaxLinesPerMessage(params) {
	if (typeof params.discordConfig?.maxLinesPerMessage === "number") return params.discordConfig.maxLinesPerMessage;
	return resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.maxLinesPerMessage;
}
function listEnabledDiscordAccounts(cfg) {
	return listDiscordAccountIds(cfg).map((accountId) => resolveDiscordAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
var listAccountIds, resolveDefaultAccountId, listDiscordAccountIds, resolveDefaultDiscordAccountId;
var init_accounts = __esmMin((() => {
	init_account_action_gate();
	init_account_helpers();
	init_account_lookup();
	init_session_key();
	init_token();
	({listAccountIds, resolveDefaultAccountId} = createAccountListHelpers("discord"));
	listDiscordAccountIds = listAccountIds;
	resolveDefaultDiscordAccountId = resolveDefaultAccountId;
}));
//#endregion
//#region extensions/discord/src/api.ts
function parseDiscordApiErrorPayload(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
	try {
		const payload = JSON.parse(trimmed);
		if (payload && typeof payload === "object") return payload;
	} catch {
		return null;
	}
	return null;
}
function parseRetryAfterSeconds(text, response) {
	const payload = parseDiscordApiErrorPayload(text);
	const retryAfter = payload && typeof payload.retry_after === "number" && Number.isFinite(payload.retry_after) ? payload.retry_after : void 0;
	if (retryAfter !== void 0) return retryAfter;
	const header = response.headers.get("Retry-After");
	if (!header) return;
	const parsed = Number(header);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function formatRetryAfterSeconds(value) {
	if (value === void 0 || !Number.isFinite(value) || value < 0) return;
	return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()}s`;
}
function formatDiscordApiErrorText(text) {
	const trimmed = text.trim();
	if (!trimmed) return;
	const payload = parseDiscordApiErrorPayload(trimmed);
	if (!payload) return trimmed.startsWith("{") && trimmed.endsWith("}") ? "unknown error" : trimmed;
	const message = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : "unknown error";
	const retryAfter = formatRetryAfterSeconds(typeof payload.retry_after === "number" ? payload.retry_after : void 0);
	return retryAfter ? `${message} (retry after ${retryAfter})` : message;
}
async function fetchDiscord(path, token, fetcher = fetch, options) {
	const fetchImpl = resolveFetch(fetcher);
	if (!fetchImpl) throw new Error("fetch is not available");
	return retryAsync(async () => {
		const res = await fetchImpl(`${DISCORD_API_BASE}${path}`, { headers: { Authorization: `Bot ${token}` } });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			const detail = formatDiscordApiErrorText(text);
			const suffix = detail ? `: ${detail}` : "";
			const retryAfter = res.status === 429 ? parseRetryAfterSeconds(text, res) : void 0;
			throw new DiscordApiError(`Discord API ${path} failed (${res.status})${suffix}`, res.status, retryAfter);
		}
		return await res.json();
	}, {
		...resolveRetryConfig(DISCORD_API_RETRY_DEFAULTS, options?.retry),
		label: options?.label ?? path,
		shouldRetry: (err) => err instanceof DiscordApiError && err.status === 429,
		retryAfterMs: (err) => err instanceof DiscordApiError && typeof err.retryAfter === "number" ? err.retryAfter * 1e3 : void 0
	});
}
var DISCORD_API_BASE, DISCORD_API_RETRY_DEFAULTS, DiscordApiError;
var init_api = __esmMin((() => {
	init_fetch();
	init_retry();
	DISCORD_API_BASE = "https://discord.com/api/v10";
	DISCORD_API_RETRY_DEFAULTS = {
		attempts: 3,
		minDelayMs: 500,
		maxDelayMs: 3e4,
		jitter: .1
	};
	DiscordApiError = class extends Error {
		constructor(message, status, retryAfter) {
			super(message);
			this.status = status;
			this.retryAfter = retryAfter;
		}
	};
}));
//#endregion
//#region src/channels/channel-config.ts
function applyChannelMatchMeta(result, match) {
	if (match.matchKey && match.matchSource) {
		result.matchKey = match.matchKey;
		result.matchSource = match.matchSource;
	}
	return result;
}
function resolveChannelMatchConfig(match, resolveEntry) {
	if (!match.entry) return null;
	return applyChannelMatchMeta(resolveEntry(match.entry), match);
}
function normalizeChannelSlug(value) {
	return value.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function buildChannelKeyCandidates(...keys) {
	const seen = /* @__PURE__ */ new Set();
	const candidates = [];
	for (const key of keys) {
		if (typeof key !== "string") continue;
		const trimmed = key.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		candidates.push(trimmed);
	}
	return candidates;
}
function resolveChannelEntryMatch(params) {
	const entries = params.entries ?? {};
	const match = {};
	for (const key of params.keys) {
		if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
		match.entry = entries[key];
		match.key = key;
		break;
	}
	if (params.wildcardKey && Object.prototype.hasOwnProperty.call(entries, params.wildcardKey)) {
		match.wildcardEntry = entries[params.wildcardKey];
		match.wildcardKey = params.wildcardKey;
	}
	return match;
}
function resolveChannelEntryMatchWithFallback(params) {
	const direct = resolveChannelEntryMatch({
		entries: params.entries,
		keys: params.keys,
		wildcardKey: params.wildcardKey
	});
	if (direct.entry && direct.key) return {
		...direct,
		matchKey: direct.key,
		matchSource: "direct"
	};
	const normalizeKey = params.normalizeKey;
	if (normalizeKey) {
		const normalizedKeys = params.keys.map((key) => normalizeKey(key)).filter(Boolean);
		if (normalizedKeys.length > 0) for (const [entryKey, entry] of Object.entries(params.entries ?? {})) {
			const normalizedEntry = normalizeKey(entryKey);
			if (normalizedEntry && normalizedKeys.includes(normalizedEntry)) return {
				...direct,
				entry,
				key: entryKey,
				matchKey: entryKey,
				matchSource: "direct"
			};
		}
	}
	const parentKeys = params.parentKeys ?? [];
	if (parentKeys.length > 0) {
		const parent = resolveChannelEntryMatch({
			entries: params.entries,
			keys: parentKeys
		});
		if (parent.entry && parent.key) return {
			...direct,
			entry: parent.entry,
			key: parent.key,
			parentEntry: parent.entry,
			parentKey: parent.key,
			matchKey: parent.key,
			matchSource: "parent"
		};
		if (normalizeKey) {
			const normalizedParentKeys = parentKeys.map((key) => normalizeKey(key)).filter(Boolean);
			if (normalizedParentKeys.length > 0) for (const [entryKey, entry] of Object.entries(params.entries ?? {})) {
				const normalizedEntry = normalizeKey(entryKey);
				if (normalizedEntry && normalizedParentKeys.includes(normalizedEntry)) return {
					...direct,
					entry,
					key: entryKey,
					parentEntry: entry,
					parentKey: entryKey,
					matchKey: entryKey,
					matchSource: "parent"
				};
			}
		}
	}
	if (direct.wildcardEntry && direct.wildcardKey) return {
		...direct,
		entry: direct.wildcardEntry,
		key: direct.wildcardKey,
		matchKey: direct.wildcardKey,
		matchSource: "wildcard"
	};
	return direct;
}
function resolveNestedAllowlistDecision(params) {
	if (!params.outerConfigured) return true;
	if (!params.outerMatched) return false;
	if (!params.innerConfigured) return true;
	return params.innerMatched;
}
var init_channel_config = __esmMin((() => {}));
//#endregion
//#region src/config/runtime-group-policy.ts
function resolveRuntimeGroupPolicy(params) {
	const configuredFallbackPolicy = params.configuredFallbackPolicy ?? "open";
	const missingProviderFallbackPolicy = params.missingProviderFallbackPolicy ?? "allowlist";
	return {
		groupPolicy: params.providerConfigPresent ? params.groupPolicy ?? params.defaultGroupPolicy ?? configuredFallbackPolicy : params.groupPolicy ?? missingProviderFallbackPolicy,
		providerMissingFallbackApplied: !params.providerConfigPresent && params.groupPolicy === void 0
	};
}
function resolveDefaultGroupPolicy(cfg) {
	return cfg.channels?.defaults?.groupPolicy;
}
/**
* Standard provider runtime policy:
* - configured provider fallback: open
* - missing provider fallback: allowlist (fail-closed)
*/
function resolveOpenProviderRuntimeGroupPolicy(params) {
	return resolveRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.groupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy,
		configuredFallbackPolicy: "open",
		missingProviderFallbackPolicy: "allowlist"
	});
}
/**
* Strict provider runtime policy:
* - configured provider fallback: allowlist
* - missing provider fallback: allowlist (fail-closed)
*/
function resolveAllowlistProviderRuntimeGroupPolicy(params) {
	return resolveRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.groupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy,
		configuredFallbackPolicy: "allowlist",
		missingProviderFallbackPolicy: "allowlist"
	});
}
function warnMissingProviderGroupPolicyFallbackOnce(params) {
	if (!params.providerMissingFallbackApplied) return false;
	const key = `${params.providerKey}:${params.accountId ?? "*"}`;
	if (warnedMissingProviderGroupPolicy.has(key)) return false;
	warnedMissingProviderGroupPolicy.add(key);
	const blockedLabel = params.blockedLabel?.trim() || "group messages";
	params.log(`${params.providerKey}: channels.${params.providerKey} is missing; defaulting groupPolicy to "allowlist" (${blockedLabel} blocked until explicitly configured).`);
	return true;
}
var GROUP_POLICY_BLOCKED_LABEL, warnedMissingProviderGroupPolicy;
var init_runtime_group_policy = __esmMin((() => {
	GROUP_POLICY_BLOCKED_LABEL = {
		group: "group messages",
		guild: "guild messages",
		room: "room messages",
		channel: "channel messages",
		space: "space messages"
	};
	warnedMissingProviderGroupPolicy = /* @__PURE__ */ new Set();
}));
//#endregion
//#region src/plugin-sdk/group-access.ts
/** Downgrade sender-scoped group policy to open mode when no allowlist is configured. */
function resolveSenderScopedGroupPolicy(params) {
	if (params.groupPolicy === "disabled") return "disabled";
	return params.groupAllowFrom.length > 0 ? "allowlist" : "open";
}
/** Evaluate route-level group access after policy, route match, and enablement checks. */
function evaluateGroupRouteAccessForPolicy(params) {
	if (params.groupPolicy === "disabled") return {
		allowed: false,
		groupPolicy: params.groupPolicy,
		reason: "disabled"
	};
	if (params.routeMatched && params.routeEnabled === false) return {
		allowed: false,
		groupPolicy: params.groupPolicy,
		reason: "route_disabled"
	};
	if (params.groupPolicy === "allowlist") {
		if (!params.routeAllowlistConfigured) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "empty_allowlist"
		};
		if (!params.routeMatched) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "route_not_allowlisted"
		};
	}
	return {
		allowed: true,
		groupPolicy: params.groupPolicy,
		reason: "allowed"
	};
}
/** Evaluate generic allowlist match state for channels that compare derived group identifiers. */
function evaluateMatchedGroupAccessForPolicy(params) {
	if (params.groupPolicy === "disabled") return {
		allowed: false,
		groupPolicy: params.groupPolicy,
		reason: "disabled"
	};
	if (params.groupPolicy === "allowlist") {
		if (params.requireMatchInput && !params.hasMatchInput) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "missing_match_input"
		};
		if (!params.allowlistConfigured) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "empty_allowlist"
		};
		if (!params.allowlistMatched) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "not_allowlisted"
		};
	}
	return {
		allowed: true,
		groupPolicy: params.groupPolicy,
		reason: "allowed"
	};
}
/** Evaluate sender access for an already-resolved group policy and allowlist. */
function evaluateSenderGroupAccessForPolicy(params) {
	if (params.groupPolicy === "disabled") return {
		allowed: false,
		groupPolicy: params.groupPolicy,
		providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
		reason: "disabled"
	};
	if (params.groupPolicy === "allowlist") {
		if (params.groupAllowFrom.length === 0) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
			reason: "empty_allowlist"
		};
		if (!params.isSenderAllowed(params.senderId, params.groupAllowFrom)) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
			reason: "sender_not_allowlisted"
		};
	}
	return {
		allowed: true,
		groupPolicy: params.groupPolicy,
		providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
		reason: "allowed"
	};
}
/** Resolve provider fallback policy first, then evaluate sender access against that result. */
function evaluateSenderGroupAccess(params) {
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.configuredGroupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy
	});
	return evaluateSenderGroupAccessForPolicy({
		groupPolicy,
		providerMissingFallbackApplied,
		groupAllowFrom: params.groupAllowFrom,
		senderId: params.senderId,
		isSenderAllowed: params.isSenderAllowed
	});
}
var init_group_access = __esmMin((() => {
	init_runtime_group_policy();
}));
//#endregion
//#region extensions/discord/src/monitor/format.ts
function resolveDiscordSystemLocation(params) {
	const { isDirectMessage, isGroupDm, guild, channelName } = params;
	if (isDirectMessage) return "DM";
	if (isGroupDm) return `Group DM #${channelName}`;
	return guild?.name ? `${guild.name} #${channelName}` : `#${channelName}`;
}
function formatDiscordReactionEmoji(emoji) {
	if (emoji.id && emoji.name) return `<:${emoji.name}:${emoji.id}>`;
	if (emoji.id) return `emoji:${emoji.id}`;
	return emoji.name ?? "emoji";
}
function formatDiscordUserTag(user) {
	const discriminator = (user.discriminator ?? "").trim();
	if (discriminator && discriminator !== "0") return `${user.username}#${discriminator}`;
	return user.username ?? user.id;
}
function resolveTimestampMs(timestamp) {
	if (!timestamp) return;
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? void 0 : parsed;
}
var init_format = __esmMin((() => {}));
//#endregion
//#region extensions/discord/src/monitor/allow-list.ts
function normalizeDiscordAllowList(raw, prefixes) {
	if (!raw || raw.length === 0) return null;
	const ids = /* @__PURE__ */ new Set();
	const names = /* @__PURE__ */ new Set();
	const allowAll = raw.some((entry) => String(entry).trim() === "*");
	for (const entry of raw) {
		const text = String(entry).trim();
		if (!text || text === "*") continue;
		const normalized = normalizeDiscordSlug(text);
		const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
		if (/^\d+$/.test(maybeId)) {
			ids.add(maybeId);
			continue;
		}
		const prefix = prefixes.find((entry) => text.startsWith(entry));
		if (prefix) {
			const candidate = text.slice(prefix.length);
			if (candidate) ids.add(candidate);
			continue;
		}
		if (normalized) names.add(normalized);
	}
	return {
		allowAll,
		ids,
		names
	};
}
function normalizeDiscordSlug(value) {
	return value.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function resolveDiscordAllowListNameMatch(list, candidate) {
	const nameSlug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
	if (nameSlug && list.names.has(nameSlug)) return {
		matchKey: nameSlug,
		matchSource: "name"
	};
	const tagSlug = candidate.tag ? normalizeDiscordSlug(candidate.tag) : "";
	if (tagSlug && list.names.has(tagSlug)) return {
		matchKey: tagSlug,
		matchSource: "tag"
	};
	return null;
}
function allowListMatches(list, candidate, params) {
	if (list.allowAll) return true;
	if (candidate.id && list.ids.has(candidate.id)) return true;
	if (params?.allowNameMatching === true) {
		if (resolveDiscordAllowListNameMatch(list, candidate)) return true;
	}
	return false;
}
function resolveDiscordAllowListMatch(params) {
	const { allowList, candidate } = params;
	if (allowList.allowAll) return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};
	if (candidate.id && allowList.ids.has(candidate.id)) return {
		allowed: true,
		matchKey: candidate.id,
		matchSource: "id"
	};
	if (params.allowNameMatching === true) {
		const namedMatch = resolveDiscordAllowListNameMatch(allowList, candidate);
		if (namedMatch) return {
			allowed: true,
			...namedMatch
		};
	}
	return { allowed: false };
}
function resolveDiscordUserAllowed(params) {
	const allowList = normalizeDiscordAllowList(params.allowList, [
		"discord:",
		"user:",
		"pk:"
	]);
	if (!allowList) return true;
	return allowListMatches(allowList, {
		id: params.userId,
		name: params.userName,
		tag: params.userTag
	}, { allowNameMatching: params.allowNameMatching });
}
function resolveDiscordRoleAllowed(params) {
	const allowList = normalizeDiscordAllowList(params.allowList, ["role:"]);
	if (!allowList) return true;
	if (allowList.allowAll) return true;
	return params.memberRoleIds.some((roleId) => allowList.ids.has(roleId));
}
function resolveDiscordMemberAllowed(params) {
	const hasUserRestriction = Array.isArray(params.userAllowList) && params.userAllowList.length > 0;
	const hasRoleRestriction = Array.isArray(params.roleAllowList) && params.roleAllowList.length > 0;
	if (!hasUserRestriction && !hasRoleRestriction) return true;
	const userOk = hasUserRestriction ? resolveDiscordUserAllowed({
		allowList: params.userAllowList,
		userId: params.userId,
		userName: params.userName,
		userTag: params.userTag,
		allowNameMatching: params.allowNameMatching
	}) : false;
	const roleOk = hasRoleRestriction ? resolveDiscordRoleAllowed({
		allowList: params.roleAllowList,
		memberRoleIds: params.memberRoleIds
	}) : false;
	return userOk || roleOk;
}
function resolveDiscordMemberAccessState(params) {
	const channelUsers = params.channelConfig?.users ?? params.guildInfo?.users;
	const channelRoles = params.channelConfig?.roles ?? params.guildInfo?.roles;
	return {
		channelUsers,
		channelRoles,
		hasAccessRestrictions: Array.isArray(channelUsers) && channelUsers.length > 0 || Array.isArray(channelRoles) && channelRoles.length > 0,
		memberAllowed: resolveDiscordMemberAllowed({
			userAllowList: channelUsers,
			roleAllowList: channelRoles,
			memberRoleIds: params.memberRoleIds,
			userId: params.sender.id,
			userName: params.sender.name,
			userTag: params.sender.tag,
			allowNameMatching: params.allowNameMatching
		})
	};
}
function resolveDiscordOwnerAllowFrom(params) {
	const rawAllowList = params.channelConfig?.users ?? params.guildInfo?.users;
	if (!Array.isArray(rawAllowList) || rawAllowList.length === 0) return;
	const allowList = normalizeDiscordAllowList(rawAllowList, [
		"discord:",
		"user:",
		"pk:"
	]);
	if (!allowList) return;
	const match = resolveDiscordAllowListMatch({
		allowList,
		candidate: {
			id: params.sender.id,
			name: params.sender.name,
			tag: params.sender.tag
		},
		allowNameMatching: params.allowNameMatching
	});
	if (!match.allowed || !match.matchKey || match.matchKey === "*") return;
	return [match.matchKey];
}
function resolveDiscordOwnerAccess(params) {
	const ownerAllowList = normalizeDiscordAllowList(params.allowFrom, DISCORD_OWNER_ALLOWLIST_PREFIXES);
	return {
		ownerAllowList,
		ownerAllowed: ownerAllowList ? allowListMatches(ownerAllowList, {
			id: params.sender.id,
			name: params.sender.name,
			tag: params.sender.tag
		}, { allowNameMatching: params.allowNameMatching }) : false
	};
}
function resolveDiscordGuildEntry(params) {
	const guild = params.guild;
	const entries = params.guildEntries;
	const guildId = params.guildId?.trim() || guild?.id;
	if (!entries) return null;
	const byId = guildId ? entries[guildId] : void 0;
	if (byId) return {
		...byId,
		id: guildId
	};
	if (!guild) return null;
	const slug = normalizeDiscordSlug(guild.name ?? "");
	const bySlug = entries[slug];
	if (bySlug) return {
		...bySlug,
		id: guildId ?? guild.id,
		slug: slug || bySlug.slug
	};
	const wildcard = entries["*"];
	if (wildcard) return {
		...wildcard,
		id: guildId ?? guild.id,
		slug: slug || wildcard.slug
	};
	return null;
}
function buildDiscordChannelKeys(params) {
	const allowNameMatch = params.allowNameMatch !== false;
	return buildChannelKeyCandidates(params.id, allowNameMatch ? params.slug : void 0, allowNameMatch ? params.name : void 0);
}
function resolveDiscordChannelEntryMatch(channels, params, parentParams) {
	return resolveChannelEntryMatchWithFallback({
		entries: channels,
		keys: buildDiscordChannelKeys(params),
		parentKeys: parentParams ? buildDiscordChannelKeys(parentParams) : void 0,
		wildcardKey: "*"
	});
}
function hasConfiguredDiscordChannels(channels) {
	return Boolean(channels && Object.keys(channels).length > 0);
}
function resolveDiscordChannelConfigEntry(entry) {
	return {
		allowed: entry.allow !== false,
		requireMention: entry.requireMention,
		ignoreOtherMentions: entry.ignoreOtherMentions,
		skills: entry.skills,
		enabled: entry.enabled,
		users: entry.users,
		roles: entry.roles,
		systemPrompt: entry.systemPrompt,
		includeThreadStarter: entry.includeThreadStarter,
		autoThread: entry.autoThread,
		autoArchiveDuration: entry.autoArchiveDuration
	};
}
function resolveDiscordChannelConfigWithFallback(params) {
	const { guildInfo, channelId, channelName, channelSlug, parentId, parentName, parentSlug, scope } = params;
	const channels = guildInfo?.channels;
	if (!hasConfiguredDiscordChannels(channels)) return null;
	const resolvedParentSlug = parentSlug ?? (parentName ? normalizeDiscordSlug(parentName) : "");
	return resolveChannelMatchConfig(resolveDiscordChannelEntryMatch(channels, {
		id: channelId,
		name: channelName,
		slug: channelSlug,
		allowNameMatch: scope !== "thread"
	}, parentId || parentName || parentSlug ? {
		id: parentId ?? "",
		name: parentName,
		slug: resolvedParentSlug
	} : void 0), resolveDiscordChannelConfigEntry) ?? { allowed: false };
}
function resolveDiscordShouldRequireMention(params) {
	if (!params.isGuildMessage) return false;
	if (params.isAutoThreadOwnedByBot ?? isDiscordAutoThreadOwnedByBot(params)) return false;
	return params.channelConfig?.requireMention ?? params.guildInfo?.requireMention ?? true;
}
function isDiscordAutoThreadOwnedByBot(params) {
	if (!params.isThread) return false;
	if (!params.channelConfig?.autoThread) return false;
	const botId = params.botId?.trim();
	const threadOwnerId = params.threadOwnerId?.trim();
	return Boolean(botId && threadOwnerId && botId === threadOwnerId);
}
function isDiscordGroupAllowedByPolicy(params) {
	if (params.groupPolicy === "allowlist" && !params.guildAllowlisted) return false;
	return evaluateGroupRouteAccessForPolicy({
		groupPolicy: params.groupPolicy === "allowlist" && !params.channelAllowlistConfigured ? "open" : params.groupPolicy,
		routeAllowlistConfigured: params.channelAllowlistConfigured,
		routeMatched: params.channelAllowed
	}).allowed;
}
function resolveGroupDmAllow(params) {
	const { channels, channelId, channelName, channelSlug } = params;
	if (!channels || channels.length === 0) return true;
	const allowList = new Set(channels.map((entry) => normalizeDiscordSlug(String(entry))));
	const candidates = [
		normalizeDiscordSlug(channelId),
		channelSlug,
		channelName ? normalizeDiscordSlug(channelName) : ""
	].filter(Boolean);
	return allowList.has("*") || candidates.some((candidate) => allowList.has(candidate));
}
function shouldEmitDiscordReactionNotification(params) {
	const mode = params.mode ?? "own";
	if (mode === "off") return false;
	const accessGuildInfo = params.guildInfo ?? (params.allowlist ? { users: params.allowlist } : null);
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig: params.channelConfig,
		guildInfo: accessGuildInfo,
		memberRoleIds: params.memberRoleIds ?? [],
		sender: {
			id: params.userId,
			name: params.userName,
			tag: params.userTag
		},
		allowNameMatching: params.allowNameMatching
	});
	if (mode === "allowlist") return hasAccessRestrictions && memberAllowed;
	if (hasAccessRestrictions && !memberAllowed) return false;
	if (mode === "all") return true;
	if (mode === "own") return Boolean(params.botId && params.messageAuthorId === params.botId);
	return false;
}
var DISCORD_OWNER_ALLOWLIST_PREFIXES;
var init_allow_list = __esmMin((() => {
	init_channel_config();
	init_group_access();
	DISCORD_OWNER_ALLOWLIST_PREFIXES = [
		"discord:",
		"user:",
		"pk:"
	];
}));
//#endregion
//#region extensions/discord/src/directory-live.ts
function normalizeQuery(value) {
	return value?.trim().toLowerCase() ?? "";
}
function buildUserRank(user) {
	return user.bot ? 0 : 1;
}
function resolveDiscordDirectoryAccess(params) {
	const token = normalizeDiscordToken(resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).token, "channels.discord.token");
	if (!token) return null;
	return {
		token,
		query: normalizeQuery(params.query)
	};
}
async function listDiscordGuilds(token) {
	return (await fetchDiscord("/users/@me/guilds", token)).filter((guild) => guild.id && guild.name);
}
async function listDiscordDirectoryGroupsLive(params) {
	const access = resolveDiscordDirectoryAccess(params);
	if (!access) return [];
	const { token, query } = access;
	const guilds = await listDiscordGuilds(token);
	const rows = [];
	for (const guild of guilds) {
		const channels = await fetchDiscord(`/guilds/${guild.id}/channels`, token);
		for (const channel of channels) {
			const name = channel.name?.trim();
			if (!name) continue;
			if (query && !normalizeDiscordSlug(name).includes(normalizeDiscordSlug(query))) continue;
			rows.push({
				kind: "group",
				id: `channel:${channel.id}`,
				name,
				handle: `#${name}`,
				raw: channel
			});
			if (typeof params.limit === "number" && params.limit > 0 && rows.length >= params.limit) return rows;
		}
	}
	return rows;
}
async function listDiscordDirectoryPeersLive(params) {
	const access = resolveDiscordDirectoryAccess(params);
	if (!access) return [];
	const { token, query } = access;
	if (!query) return [];
	const guilds = await listDiscordGuilds(token);
	const rows = [];
	const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 25;
	for (const guild of guilds) {
		const paramsObj = new URLSearchParams({
			query,
			limit: String(Math.min(limit, 100))
		});
		const members = await fetchDiscord(`/guilds/${guild.id}/members/search?${paramsObj.toString()}`, token);
		for (const member of members) {
			const user = member.user;
			if (!user?.id) continue;
			rememberDiscordDirectoryUser({
				accountId: params.accountId,
				userId: user.id,
				handles: [
					user.username,
					user.global_name,
					member.nick,
					user.username ? `@${user.username}` : null
				]
			});
			const name = member.nick?.trim() || user.global_name?.trim() || user.username?.trim();
			rows.push({
				kind: "user",
				id: `user:${user.id}`,
				name: name || void 0,
				handle: user.username ? `@${user.username}` : void 0,
				rank: buildUserRank(user),
				raw: member
			});
			if (rows.length >= limit) return rows;
		}
	}
	return rows;
}
var init_directory_live = __esmMin((() => {
	init_accounts();
	init_api();
	init_directory_cache();
	init_allow_list();
	init_token();
}));
//#endregion
//#region extensions/discord/src/targets.ts
function parseDiscordTarget(raw, options = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const userTarget = parseMentionPrefixOrAtUserTarget({
		raw: trimmed,
		mentionPattern: /^<@!?(\d+)>$/,
		prefixes: [
			{
				prefix: "user:",
				kind: "user"
			},
			{
				prefix: "channel:",
				kind: "channel"
			},
			{
				prefix: "discord:",
				kind: "user"
			}
		],
		atUserPattern: /^\d+$/,
		atUserErrorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)"
	});
	if (userTarget) return userTarget;
	if (/^\d+$/.test(trimmed)) {
		if (options.defaultKind) return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
		throw new Error(options.ambiguousMessage ?? `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`);
	}
	return buildMessagingTarget("channel", trimmed, trimmed);
}
function resolveDiscordChannelId(raw) {
	return requireTargetKind({
		platform: "Discord",
		target: parseDiscordTarget(raw, { defaultKind: "channel" }),
		kind: "channel"
	});
}
/**
* Resolve a Discord username to user ID using the directory lookup.
* This enables sending DMs by username instead of requiring explicit user IDs.
*
* @param raw - The username or raw target string (e.g., "john.doe")
* @param options - Directory configuration params (cfg, accountId, limit)
* @param parseOptions - Messaging target parsing options (defaults, ambiguity message)
* @returns Parsed MessagingTarget with user ID, or undefined if not found
*/
async function resolveDiscordTarget(raw, options, parseOptions = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const likelyUsername = isLikelyUsername(trimmed);
	const shouldLookup = isExplicitUserLookup(trimmed, parseOptions) || likelyUsername;
	const directParse = safeParseDiscordTarget(trimmed, parseOptions);
	if (directParse && directParse.kind !== "channel" && !likelyUsername) return directParse;
	if (!shouldLookup) return directParse ?? parseDiscordTarget(trimmed, parseOptions);
	try {
		const match = (await listDiscordDirectoryPeersLive({
			...options,
			query: trimmed,
			limit: 1
		}))[0];
		if (match && match.kind === "user") {
			const userId = match.id.replace(/^user:/, "");
			rememberDiscordDirectoryUser({
				accountId: options.accountId,
				userId,
				handles: [
					trimmed,
					match.name,
					match.handle
				]
			});
			return buildMessagingTarget("user", userId, trimmed);
		}
	} catch {}
	return parseDiscordTarget(trimmed, parseOptions);
}
function safeParseDiscordTarget(input, options) {
	try {
		return parseDiscordTarget(input, options);
	} catch {
		return;
	}
}
function isExplicitUserLookup(input, options) {
	if (/^<@!?(\d+)>$/.test(input)) return true;
	if (/^(user:|discord:)/.test(input)) return true;
	if (input.startsWith("@")) return true;
	if (/^\d+$/.test(input)) return options.defaultKind === "user";
	return false;
}
/**
* Check if a string looks like a Discord username (not a mention, prefix, or ID).
* Usernames typically don't start with special characters except underscore.
*/
function isLikelyUsername(input) {
	if (/^(user:|channel:|discord:|@|<@!?)|[\d]+$/.test(input)) return false;
	return true;
}
var init_targets$1 = __esmMin((() => {
	init_targets$2();
	init_directory_cache();
	init_directory_live();
}));
//#endregion
//#region extensions/telegram/src/targets.ts
function stripTelegramInternalPrefixes(to) {
	let trimmed = to.trim();
	let strippedTelegramPrefix = false;
	while (true) {
		const next = (() => {
			if (/^(telegram|tg):/i.test(trimmed)) {
				strippedTelegramPrefix = true;
				return trimmed.replace(/^(telegram|tg):/i, "").trim();
			}
			if (strippedTelegramPrefix && /^group:/i.test(trimmed)) return trimmed.replace(/^group:/i, "").trim();
			return trimmed;
		})();
		if (next === trimmed) return trimmed;
		trimmed = next;
	}
}
function normalizeTelegramChatId(raw) {
	const stripped = stripTelegramInternalPrefixes(raw);
	if (!stripped) return;
	if (TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(stripped)) return stripped;
}
function isNumericTelegramChatId(raw) {
	return TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(raw.trim());
}
function normalizeTelegramLookupTarget(raw) {
	const stripped = stripTelegramInternalPrefixes(raw);
	if (!stripped) return;
	if (isNumericTelegramChatId(stripped)) return stripped;
	const tmeMatch = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)$/i.exec(stripped);
	if (tmeMatch?.[1]) return `@${tmeMatch[1]}`;
	if (stripped.startsWith("@")) {
		const handle = stripped.slice(1);
		if (!handle || !TELEGRAM_USERNAME_REGEX.test(handle)) return;
		return `@${handle}`;
	}
	if (TELEGRAM_USERNAME_REGEX.test(stripped)) return `@${stripped}`;
}
/**
* Parse a Telegram delivery target into chatId and optional topic/thread ID.
*
* Supported formats:
* - `chatId` (plain chat ID, t.me link, @username, or internal prefixes like `telegram:...`)
* - `chatId:topicId` (numeric topic/thread ID)
* - `chatId:topic:topicId` (explicit topic marker; preferred)
*/
function resolveTelegramChatType(chatId) {
	const trimmed = chatId.trim();
	if (!trimmed) return "unknown";
	if (isNumericTelegramChatId(trimmed)) return trimmed.startsWith("-") ? "group" : "direct";
	return "unknown";
}
function parseTelegramTarget(to) {
	const normalized = stripTelegramInternalPrefixes(to);
	const topicMatch = /^(.+?):topic:(\d+)$/.exec(normalized);
	if (topicMatch) return {
		chatId: topicMatch[1],
		messageThreadId: Number.parseInt(topicMatch[2], 10),
		chatType: resolveTelegramChatType(topicMatch[1])
	};
	const colonMatch = /^(.+):(\d+)$/.exec(normalized);
	if (colonMatch) return {
		chatId: colonMatch[1],
		messageThreadId: Number.parseInt(colonMatch[2], 10),
		chatType: resolveTelegramChatType(colonMatch[1])
	};
	return {
		chatId: normalized,
		chatType: resolveTelegramChatType(normalized)
	};
}
function resolveTelegramTargetChatType(target) {
	return parseTelegramTarget(target).chatType;
}
var TELEGRAM_NUMERIC_CHAT_ID_REGEX, TELEGRAM_USERNAME_REGEX;
var init_targets = __esmMin((() => {
	TELEGRAM_NUMERIC_CHAT_ID_REGEX = /^-?\d+$/;
	TELEGRAM_USERNAME_REGEX = /^[A-Za-z0-9_]{5,}$/i;
}));
//#endregion
//#region src/channels/plugins/registry.ts
function dedupeChannels(channels) {
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const plugin of channels) {
		const id = String(plugin.id).trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		resolved.push(plugin);
	}
	return resolved;
}
function resolveCachedChannelPlugins() {
	const registry = requireActivePluginRegistry();
	const registryVersion = getActivePluginRegistryVersion();
	const cached = cachedChannelPlugins;
	if (cached.registryVersion === registryVersion) return cached;
	const sorted = dedupeChannels(registry.channels.map((entry) => entry.plugin)).toSorted((a, b) => {
		const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
		const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
		const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
		const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
		if (orderA !== orderB) return orderA - orderB;
		return a.id.localeCompare(b.id);
	});
	const byId = /* @__PURE__ */ new Map();
	for (const plugin of sorted) byId.set(plugin.id, plugin);
	const next = {
		registryVersion,
		sorted,
		byId
	};
	cachedChannelPlugins = next;
	return next;
}
function listChannelPlugins() {
	return resolveCachedChannelPlugins().sorted.slice();
}
function getChannelPlugin(id) {
	const resolvedId = String(id).trim();
	if (!resolvedId) return;
	return resolveCachedChannelPlugins().byId.get(resolvedId);
}
function normalizeChannelId$1(raw) {
	return normalizeAnyChannelId(raw);
}
var cachedChannelPlugins;
var init_registry$2 = __esmMin((() => {
	init_runtime();
	init_registry();
	cachedChannelPlugins = {
		registryVersion: -1,
		sorted: [],
		byId: /* @__PURE__ */ new Map()
	};
}));
//#endregion
//#region src/channels/plugins/target-parsing.ts
function parseWithPlugin(rawChannel, rawTarget) {
	const channel = normalizeChatChannelId(rawChannel) ?? normalizeChannelId$1(rawChannel);
	if (!channel) return null;
	if (channel === "telegram") {
		const target = parseTelegramTarget(rawTarget);
		return {
			to: target.chatId,
			...target.messageThreadId != null ? { threadId: target.messageThreadId } : {},
			...target.chatType === "unknown" ? {} : { chatType: target.chatType }
		};
	}
	if (channel === "discord") {
		const target = parseDiscordTarget(rawTarget, { defaultKind: "channel" });
		if (!target) return null;
		return {
			to: target.id,
			chatType: target.kind === "user" ? "direct" : "channel"
		};
	}
	return getChannelPlugin(channel)?.messaging?.parseExplicitTarget?.({ raw: rawTarget }) ?? null;
}
function parseExplicitTargetForChannel(channel, rawTarget) {
	return parseWithPlugin(channel, rawTarget);
}
var init_target_parsing = __esmMin((() => {
	init_targets$1();
	init_targets();
	init_registry();
	init_registry$2();
}));
//#endregion
//#region src/infra/outbound/session-binding-service.ts
function isSessionBindingError(error) {
	return error instanceof SessionBindingError;
}
function normalizeConversationRef(ref) {
	return {
		channel: ref.channel.trim().toLowerCase(),
		accountId: normalizeAccountId(ref.accountId),
		conversationId: ref.conversationId.trim(),
		parentConversationId: ref.parentConversationId?.trim() || void 0
	};
}
function toAdapterKey(params) {
	return `${params.channel.trim().toLowerCase()}:${normalizeAccountId(params.accountId)}`;
}
function normalizePlacement(raw) {
	return raw === "current" || raw === "child" ? raw : void 0;
}
function inferDefaultPlacement(ref) {
	return ref.conversationId ? "current" : "child";
}
function resolveAdapterPlacements(adapter) {
	const placements = (adapter.capabilities?.placements?.map((value) => normalizePlacement(value)))?.filter((value) => Boolean(value));
	if (placements && placements.length > 0) return [...new Set(placements)];
	return ["current", "child"];
}
function resolveAdapterCapabilities(adapter) {
	if (!adapter) return {
		adapterAvailable: false,
		bindSupported: false,
		unbindSupported: false,
		placements: []
	};
	const bindSupported = adapter.capabilities?.bindSupported ?? Boolean(adapter.bind);
	return {
		adapterAvailable: true,
		bindSupported,
		unbindSupported: adapter.capabilities?.unbindSupported ?? Boolean(adapter.unbind),
		placements: bindSupported ? resolveAdapterPlacements(adapter) : []
	};
}
function registerSessionBindingAdapter(adapter) {
	const normalizedAdapter = {
		...adapter,
		channel: adapter.channel.trim().toLowerCase(),
		accountId: normalizeAccountId(adapter.accountId)
	};
	const key = toAdapterKey({
		channel: normalizedAdapter.channel,
		accountId: normalizedAdapter.accountId
	});
	const existing = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
	if (existing && existing !== adapter) throw new Error(`Session binding adapter already registered for ${normalizedAdapter.channel}:${normalizedAdapter.accountId}`);
	ADAPTERS_BY_CHANNEL_ACCOUNT.set(key, normalizedAdapter);
}
function unregisterSessionBindingAdapter(params) {
	ADAPTERS_BY_CHANNEL_ACCOUNT.delete(toAdapterKey(params));
}
function resolveAdapterForConversation(ref) {
	return resolveAdapterForChannelAccount({
		channel: ref.channel,
		accountId: ref.accountId
	});
}
function resolveAdapterForChannelAccount(params) {
	const key = toAdapterKey({
		channel: params.channel,
		accountId: params.accountId
	});
	return ADAPTERS_BY_CHANNEL_ACCOUNT.get(key) ?? null;
}
function dedupeBindings(records) {
	const byId = /* @__PURE__ */ new Map();
	for (const record of records) {
		if (!record?.bindingId) continue;
		byId.set(record.bindingId, record);
	}
	return [...byId.values()];
}
function createDefaultSessionBindingService() {
	return {
		bind: async (input) => {
			const normalizedConversation = normalizeConversationRef(input.conversation);
			const adapter = resolveAdapterForConversation(normalizedConversation);
			if (!adapter) throw new SessionBindingError("BINDING_ADAPTER_UNAVAILABLE", `Session binding adapter unavailable for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
				channel: normalizedConversation.channel,
				accountId: normalizedConversation.accountId
			});
			if (!adapter.bind) throw new SessionBindingError("BINDING_CAPABILITY_UNSUPPORTED", `Session binding adapter does not support binding for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
				channel: normalizedConversation.channel,
				accountId: normalizedConversation.accountId
			});
			const placement = normalizePlacement(input.placement) ?? inferDefaultPlacement(normalizedConversation);
			if (!resolveAdapterPlacements(adapter).includes(placement)) throw new SessionBindingError("BINDING_CAPABILITY_UNSUPPORTED", `Session binding placement "${placement}" is not supported for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
				channel: normalizedConversation.channel,
				accountId: normalizedConversation.accountId,
				placement
			});
			const bound = await adapter.bind({
				...input,
				conversation: normalizedConversation,
				placement
			});
			if (!bound) throw new SessionBindingError("BINDING_CREATE_FAILED", "Session binding adapter failed to bind target conversation", {
				channel: normalizedConversation.channel,
				accountId: normalizedConversation.accountId,
				placement
			});
			return bound;
		},
		getCapabilities: (params) => {
			return resolveAdapterCapabilities(resolveAdapterForChannelAccount({
				channel: params.channel,
				accountId: params.accountId
			}));
		},
		listBySession: (targetSessionKey) => {
			const key = targetSessionKey.trim();
			if (!key) return [];
			const results = [];
			for (const adapter of ADAPTERS_BY_CHANNEL_ACCOUNT.values()) {
				const entries = adapter.listBySession(key);
				if (entries.length > 0) results.push(...entries);
			}
			return dedupeBindings(results);
		},
		resolveByConversation: (ref) => {
			const normalized = normalizeConversationRef(ref);
			if (!normalized.channel || !normalized.conversationId) return null;
			const adapter = resolveAdapterForConversation(normalized);
			if (!adapter) return null;
			return adapter.resolveByConversation(normalized);
		},
		touch: (bindingId, at) => {
			const normalizedBindingId = bindingId.trim();
			if (!normalizedBindingId) return;
			for (const adapter of ADAPTERS_BY_CHANNEL_ACCOUNT.values()) adapter.touch?.(normalizedBindingId, at);
		},
		unbind: async (input) => {
			const removed = [];
			for (const adapter of ADAPTERS_BY_CHANNEL_ACCOUNT.values()) {
				if (!adapter.unbind) continue;
				const entries = await adapter.unbind(input);
				if (entries.length > 0) removed.push(...entries);
			}
			return dedupeBindings(removed);
		}
	};
}
function getSessionBindingService() {
	return DEFAULT_SESSION_BINDING_SERVICE;
}
var SessionBindingError, ADAPTERS_BY_CHANNEL_ACCOUNT, DEFAULT_SESSION_BINDING_SERVICE;
var init_session_binding_service = __esmMin((() => {
	init_session_key();
	SessionBindingError = class extends Error {
		constructor(code, message, details) {
			super(message);
			this.code = code;
			this.details = details;
			this.name = "SessionBindingError";
		}
	};
	ADAPTERS_BY_CHANNEL_ACCOUNT = /* @__PURE__ */ new Map();
	DEFAULT_SESSION_BINDING_SERVICE = createDefaultSessionBindingService();
}));
//#endregion
//#region src/plugins/conversation-binding.ts
function getPluginBindingGlobalState() {
	const globalStore = globalThis;
	return globalStore[pluginBindingGlobalStateKey] ??= { fallbackNoticeBindingIds: /* @__PURE__ */ new Set() };
}
function resolveApprovalsPath() {
	return expandHomePrefix(APPROVALS_PATH);
}
function normalizeChannel(value) {
	return value.trim().toLowerCase();
}
function normalizeConversation(params) {
	return {
		channel: normalizeChannel(params.channel),
		accountId: params.accountId.trim() || "default",
		conversationId: params.conversationId.trim(),
		parentConversationId: params.parentConversationId?.trim() || void 0,
		threadId: typeof params.threadId === "number" ? Math.trunc(params.threadId) : params.threadId?.toString().trim() || void 0
	};
}
function toConversationRef(params) {
	const normalized = normalizeConversation(params);
	if (normalized.channel === "telegram") {
		const threadId = typeof normalized.threadId === "number" || typeof normalized.threadId === "string" ? String(normalized.threadId).trim() : "";
		if (threadId) {
			const parent = normalized.parentConversationId?.trim() || normalized.conversationId;
			return {
				channel: "telegram",
				accountId: normalized.accountId,
				conversationId: `${parent}:topic:${threadId}`
			};
		}
	}
	return {
		channel: normalized.channel,
		accountId: normalized.accountId,
		conversationId: normalized.conversationId,
		...normalized.parentConversationId ? { parentConversationId: normalized.parentConversationId } : {}
	};
}
function buildApprovalScopeKey(params) {
	return [
		params.pluginRoot,
		normalizeChannel(params.channel),
		params.accountId.trim() || "default"
	].join("::");
}
function buildPluginBindingSessionKey(params) {
	const hash = crypto.createHash("sha256").update(JSON.stringify({
		pluginId: params.pluginId,
		channel: normalizeChannel(params.channel),
		accountId: params.accountId,
		conversationId: params.conversationId
	})).digest("hex").slice(0, 24);
	return `${PLUGIN_BINDING_SESSION_PREFIX}:${params.pluginId}:${hash}`;
}
function isLegacyPluginBindingRecord(params) {
	if (!params.record || isPluginOwnedBindingMetadata(params.record.metadata)) return false;
	const targetSessionKey = params.record.targetSessionKey.trim();
	return targetSessionKey.startsWith(`${PLUGIN_BINDING_SESSION_PREFIX}:`) || LEGACY_CODEX_PLUGIN_SESSION_PREFIXES.some((prefix) => targetSessionKey.startsWith(prefix));
}
function buildApprovalInteractiveReply(approvalId) {
	return { blocks: [{
		type: "buttons",
		buttons: [
			{
				label: "Allow once",
				value: buildPluginBindingApprovalCustomId(approvalId, "allow-once"),
				style: "success"
			},
			{
				label: "Always allow",
				value: buildPluginBindingApprovalCustomId(approvalId, "allow-always"),
				style: "primary"
			},
			{
				label: "Deny",
				value: buildPluginBindingApprovalCustomId(approvalId, "deny"),
				style: "danger"
			}
		]
	}] };
}
function createApprovalRequestId() {
	return crypto.randomBytes(9).toString("base64url");
}
function loadApprovalsFromDisk() {
	const filePath = resolveApprovalsPath();
	try {
		if (!fs.existsSync(filePath)) return {
			version: 1,
			approvals: []
		};
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.approvals)) return {
			version: 1,
			approvals: []
		};
		return {
			version: 1,
			approvals: parsed.approvals.filter((entry) => Boolean(entry && typeof entry === "object")).map((entry) => ({
				pluginRoot: typeof entry.pluginRoot === "string" ? entry.pluginRoot : "",
				pluginId: typeof entry.pluginId === "string" ? entry.pluginId : "",
				pluginName: typeof entry.pluginName === "string" ? entry.pluginName : void 0,
				channel: typeof entry.channel === "string" ? normalizeChannel(entry.channel) : "",
				accountId: typeof entry.accountId === "string" ? entry.accountId.trim() || "default" : "default",
				approvedAt: typeof entry.approvedAt === "number" && Number.isFinite(entry.approvedAt) ? Math.floor(entry.approvedAt) : Date.now()
			})).filter((entry) => entry.pluginRoot && entry.pluginId && entry.channel)
		};
	} catch (error) {
		log.warn(`plugin binding approvals load failed: ${String(error)}`);
		return {
			version: 1,
			approvals: []
		};
	}
}
async function saveApprovals(file) {
	const filePath = resolveApprovalsPath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	approvalsCache = file;
	approvalsLoaded = true;
	await writeJsonAtomic(filePath, file, {
		mode: 384,
		trailingNewline: true
	});
}
function getApprovals() {
	if (!approvalsLoaded || !approvalsCache) {
		approvalsCache = loadApprovalsFromDisk();
		approvalsLoaded = true;
	}
	return approvalsCache;
}
function hasPersistentApproval(params) {
	const key = buildApprovalScopeKey(params);
	return getApprovals().approvals.some((entry) => buildApprovalScopeKey({
		pluginRoot: entry.pluginRoot,
		channel: entry.channel,
		accountId: entry.accountId
	}) === key);
}
async function addPersistentApproval(entry) {
	const file = getApprovals();
	const key = buildApprovalScopeKey(entry);
	const approvals = file.approvals.filter((existing) => buildApprovalScopeKey({
		pluginRoot: existing.pluginRoot,
		channel: existing.channel,
		accountId: existing.accountId
	}) !== key);
	approvals.push(entry);
	await saveApprovals({
		version: 1,
		approvals
	});
}
function buildBindingMetadata(params) {
	return {
		pluginBindingOwner: PLUGIN_BINDING_OWNER,
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		pluginRoot: params.pluginRoot,
		summary: params.summary?.trim() || void 0,
		detachHint: params.detachHint?.trim() || void 0
	};
}
function isPluginOwnedBindingMetadata(metadata) {
	if (!metadata || typeof metadata !== "object") return false;
	const record = metadata;
	return record.pluginBindingOwner === PLUGIN_BINDING_OWNER && typeof record.pluginId === "string" && typeof record.pluginRoot === "string";
}
function isPluginOwnedSessionBindingRecord(record) {
	return isPluginOwnedBindingMetadata(record?.metadata);
}
function toPluginConversationBinding(record) {
	if (!record || !isPluginOwnedBindingMetadata(record.metadata)) return null;
	const metadata = record.metadata;
	return {
		bindingId: record.bindingId,
		pluginId: metadata.pluginId,
		pluginName: metadata.pluginName,
		pluginRoot: metadata.pluginRoot,
		channel: record.conversation.channel,
		accountId: record.conversation.accountId,
		conversationId: record.conversation.conversationId,
		parentConversationId: record.conversation.parentConversationId,
		boundAt: record.boundAt,
		summary: metadata.summary,
		detachHint: metadata.detachHint
	};
}
async function bindConversationNow(params) {
	const ref = toConversationRef(params.conversation);
	const targetSessionKey = buildPluginBindingSessionKey({
		pluginId: params.identity.pluginId,
		channel: ref.channel,
		accountId: ref.accountId,
		conversationId: ref.conversationId
	});
	const binding = toPluginConversationBinding(await getSessionBindingService().bind({
		targetSessionKey,
		targetKind: "session",
		conversation: ref,
		placement: "current",
		metadata: buildBindingMetadata({
			pluginId: params.identity.pluginId,
			pluginName: params.identity.pluginName,
			pluginRoot: params.identity.pluginRoot,
			summary: params.summary,
			detachHint: params.detachHint
		})
	}));
	if (!binding) throw new Error("plugin binding was created without plugin metadata");
	return {
		...binding,
		parentConversationId: params.conversation.parentConversationId,
		threadId: params.conversation.threadId
	};
}
function buildApprovalMessage(request) {
	const lines = [
		`Plugin bind approval required`,
		`Plugin: ${request.pluginName ?? request.pluginId}`,
		`Channel: ${request.conversation.channel}`,
		`Account: ${request.conversation.accountId}`
	];
	if (request.summary?.trim()) lines.push(`Request: ${request.summary.trim()}`);
	else lines.push("Request: Bind this conversation so future plain messages route to the plugin.");
	lines.push("Choose whether to allow this plugin to bind the current conversation.");
	return lines.join("\n");
}
function resolvePluginBindingDisplayName(binding) {
	return binding.pluginName?.trim() || binding.pluginId;
}
function buildDetachHintSuffix(detachHint) {
	const trimmed = detachHint?.trim();
	return trimmed ? ` To detach this conversation, use ${trimmed}.` : "";
}
function buildPluginBindingUnavailableText(binding) {
	return `The bound plugin ${resolvePluginBindingDisplayName(binding)} is not currently loaded. Routing this message to OpenClaw instead.${buildDetachHintSuffix(binding.detachHint)}`;
}
function buildPluginBindingDeclinedText(binding) {
	return `The bound plugin ${resolvePluginBindingDisplayName(binding)} did not handle this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}
function buildPluginBindingErrorText(binding) {
	return `The bound plugin ${resolvePluginBindingDisplayName(binding)} hit an error handling this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}
function hasShownPluginBindingFallbackNotice(bindingId) {
	const normalized = bindingId.trim();
	if (!normalized) return false;
	return getPluginBindingGlobalState().fallbackNoticeBindingIds.has(normalized);
}
function markPluginBindingFallbackNoticeShown(bindingId) {
	const normalized = bindingId.trim();
	if (!normalized) return;
	getPluginBindingGlobalState().fallbackNoticeBindingIds.add(normalized);
}
function buildPendingReply(request) {
	return {
		text: buildApprovalMessage(request),
		interactive: buildApprovalInteractiveReply(request.id)
	};
}
function encodeCustomIdValue(value) {
	return encodeURIComponent(value);
}
function decodeCustomIdValue(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function buildPluginBindingApprovalCustomId(approvalId, decision) {
	const decisionCode = decision === "allow-once" ? "o" : decision === "allow-always" ? "a" : "d";
	return `${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:${encodeCustomIdValue(approvalId)}:${decisionCode}`;
}
function parsePluginBindingApprovalCustomId(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`)) return null;
	const body = trimmed.slice(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`.length);
	const separator = body.lastIndexOf(":");
	if (separator <= 0 || separator === body.length - 1) return null;
	const rawId = body.slice(0, separator).trim();
	const rawDecisionCode = body.slice(separator + 1).trim();
	if (!rawId) return null;
	const rawDecision = rawDecisionCode === "o" ? "allow-once" : rawDecisionCode === "a" ? "allow-always" : rawDecisionCode === "d" ? "deny" : null;
	if (!rawDecision) return null;
	return {
		approvalId: decodeCustomIdValue(rawId),
		decision: rawDecision
	};
}
async function requestPluginConversationBinding(params) {
	const conversation = normalizeConversation(params.conversation);
	const ref = toConversationRef(conversation);
	const existing = getSessionBindingService().resolveByConversation(ref);
	const existingPluginBinding = toPluginConversationBinding(existing);
	const existingLegacyPluginBinding = isLegacyPluginBindingRecord({ record: existing });
	if (existing && !existingPluginBinding) if (existingLegacyPluginBinding) log.info(`plugin binding migrating legacy record plugin=${params.pluginId} root=${params.pluginRoot} channel=${ref.channel} account=${ref.accountId} conversation=${ref.conversationId}`);
	else return {
		status: "error",
		message: "This conversation is already bound by core routing and cannot be claimed by a plugin."
	};
	if (existingPluginBinding && existingPluginBinding.pluginRoot !== params.pluginRoot) return {
		status: "error",
		message: `This conversation is already bound by plugin "${existingPluginBinding.pluginName ?? existingPluginBinding.pluginId}".`
	};
	if (existingPluginBinding && existingPluginBinding.pluginRoot === params.pluginRoot) {
		const rebound = await bindConversationNow({
			identity: {
				pluginId: params.pluginId,
				pluginName: params.pluginName,
				pluginRoot: params.pluginRoot
			},
			conversation,
			summary: params.binding?.summary,
			detachHint: params.binding?.detachHint
		});
		log.info(`plugin binding auto-refresh plugin=${params.pluginId} root=${params.pluginRoot} channel=${ref.channel} account=${ref.accountId} conversation=${ref.conversationId}`);
		return {
			status: "bound",
			binding: rebound
		};
	}
	if (hasPersistentApproval({
		pluginRoot: params.pluginRoot,
		channel: ref.channel,
		accountId: ref.accountId
	})) {
		const bound = await bindConversationNow({
			identity: {
				pluginId: params.pluginId,
				pluginName: params.pluginName,
				pluginRoot: params.pluginRoot
			},
			conversation,
			summary: params.binding?.summary,
			detachHint: params.binding?.detachHint
		});
		log.info(`plugin binding auto-approved plugin=${params.pluginId} root=${params.pluginRoot} channel=${ref.channel} account=${ref.accountId} conversation=${ref.conversationId}`);
		return {
			status: "bound",
			binding: bound
		};
	}
	const request = {
		id: createApprovalRequestId(),
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		pluginRoot: params.pluginRoot,
		conversation,
		requestedAt: Date.now(),
		requestedBySenderId: params.requestedBySenderId?.trim() || void 0,
		summary: params.binding?.summary?.trim() || void 0,
		detachHint: params.binding?.detachHint?.trim() || void 0
	};
	pendingRequests.set(request.id, request);
	log.info(`plugin binding requested plugin=${params.pluginId} root=${params.pluginRoot} channel=${ref.channel} account=${ref.accountId} conversation=${ref.conversationId}`);
	return {
		status: "pending",
		approvalId: request.id,
		reply: buildPendingReply(request)
	};
}
async function getCurrentPluginConversationBinding(params) {
	const binding = toPluginConversationBinding(getSessionBindingService().resolveByConversation(toConversationRef(params.conversation)));
	if (!binding || binding.pluginRoot !== params.pluginRoot) return null;
	return {
		...binding,
		parentConversationId: params.conversation.parentConversationId,
		threadId: params.conversation.threadId
	};
}
async function detachPluginConversationBinding(params) {
	const ref = toConversationRef(params.conversation);
	const binding = toPluginConversationBinding(getSessionBindingService().resolveByConversation(ref));
	if (!binding || binding.pluginRoot !== params.pluginRoot) return { removed: false };
	await getSessionBindingService().unbind({
		bindingId: binding.bindingId,
		reason: "plugin-detach"
	});
	log.info(`plugin binding detached plugin=${binding.pluginId} root=${binding.pluginRoot} channel=${binding.channel} account=${binding.accountId} conversation=${binding.conversationId}`);
	return { removed: true };
}
async function resolvePluginConversationBindingApproval(params) {
	const request = pendingRequests.get(params.approvalId);
	if (!request) return { status: "expired" };
	if (request.requestedBySenderId && params.senderId?.trim() && request.requestedBySenderId !== params.senderId.trim()) return { status: "expired" };
	pendingRequests.delete(params.approvalId);
	if (params.decision === "deny") {
		log.info(`plugin binding denied plugin=${request.pluginId} root=${request.pluginRoot} channel=${request.conversation.channel} account=${request.conversation.accountId} conversation=${request.conversation.conversationId}`);
		return {
			status: "denied",
			request
		};
	}
	if (params.decision === "allow-always") await addPersistentApproval({
		pluginRoot: request.pluginRoot,
		pluginId: request.pluginId,
		pluginName: request.pluginName,
		channel: request.conversation.channel,
		accountId: request.conversation.accountId,
		approvedAt: Date.now()
	});
	const binding = await bindConversationNow({
		identity: {
			pluginId: request.pluginId,
			pluginName: request.pluginName,
			pluginRoot: request.pluginRoot
		},
		conversation: request.conversation,
		summary: request.summary,
		detachHint: request.detachHint
	});
	log.info(`plugin binding approved plugin=${request.pluginId} root=${request.pluginRoot} decision=${params.decision} channel=${request.conversation.channel} account=${request.conversation.accountId} conversation=${request.conversation.conversationId}`);
	return {
		status: "approved",
		binding,
		request,
		decision: params.decision
	};
}
function buildPluginBindingResolvedText(params) {
	if (params.status === "expired") return "That plugin bind approval expired. Retry the bind command.";
	if (params.status === "denied") return `Denied plugin bind request for ${params.request.pluginName ?? params.request.pluginId}.`;
	const summarySuffix = params.request.summary?.trim() ? ` ${params.request.summary.trim()}` : "";
	if (params.decision === "allow-always") return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation.${summarySuffix}`;
	return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation once.${summarySuffix}`;
}
var log, APPROVALS_PATH, PLUGIN_BINDING_CUSTOM_ID_PREFIX, PLUGIN_BINDING_OWNER, PLUGIN_BINDING_SESSION_PREFIX, LEGACY_CODEX_PLUGIN_SESSION_PREFIXES, pendingRequests, pluginBindingGlobalStateKey, approvalsCache, approvalsLoaded;
var init_conversation_binding = __esmMin((() => {
	init_home_dir();
	init_json_files();
	init_session_binding_service();
	init_subsystem();
	log = createSubsystemLogger("plugins/binding");
	APPROVALS_PATH = "~/.openclaw/plugin-binding-approvals.json";
	PLUGIN_BINDING_CUSTOM_ID_PREFIX = "pluginbind";
	PLUGIN_BINDING_OWNER = "plugin";
	PLUGIN_BINDING_SESSION_PREFIX = "plugin-binding";
	LEGACY_CODEX_PLUGIN_SESSION_PREFIXES = ["openclaw-app-server:thread:", "openclaw-codex-app-server:thread:"];
	pendingRequests = /* @__PURE__ */ new Map();
	pluginBindingGlobalStateKey = Symbol.for("openclaw.plugins.binding.global-state");
	approvalsCache = null;
	approvalsLoaded = false;
}));
//#endregion
//#region src/plugins/commands.ts
/**
* Validate a command name.
* Returns an error message if invalid, or null if valid.
*/
function validateCommandName(name) {
	const trimmed = name.trim().toLowerCase();
	if (!trimmed) return "Command name cannot be empty";
	if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
	if (RESERVED_COMMANDS.has(trimmed)) return `Command name "${trimmed}" is reserved by a built-in command`;
	return null;
}
/**
* Validate a plugin command definition without registering it.
* Returns an error message if invalid, or null if valid.
* Shared by both the global registration path and snapshot (non-activating) loads.
*/
function validatePluginCommandDefinition(command) {
	if (typeof command.handler !== "function") return "Command handler must be a function";
	if (typeof command.name !== "string") return "Command name must be a string";
	if (typeof command.description !== "string") return "Command description must be a string";
	if (!command.description.trim()) return "Command description cannot be empty";
	return validateCommandName(command.name.trim());
}
/**
* Register a plugin command.
* Returns an error if the command name is invalid or reserved.
*/
function registerPluginCommand(pluginId, command, opts) {
	if (registryLocked) return {
		ok: false,
		error: "Cannot register commands while processing is in progress"
	};
	const definitionError = validatePluginCommandDefinition(command);
	if (definitionError) return {
		ok: false,
		error: definitionError
	};
	const name = command.name.trim();
	const description = command.description.trim();
	const key = `/${name.toLowerCase()}`;
	if (pluginCommands.has(key)) return {
		ok: false,
		error: `Command "${name}" already registered by plugin "${pluginCommands.get(key).pluginId}"`
	};
	pluginCommands.set(key, {
		...command,
		name,
		description,
		pluginId,
		pluginName: opts?.pluginName,
		pluginRoot: opts?.pluginRoot
	});
	logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
	return { ok: true };
}
/**
* Clear all registered plugin commands.
* Called during plugin reload.
*/
function clearPluginCommands() {
	pluginCommands.clear();
}
/**
* Check if a command body matches a registered plugin command.
* Returns the command definition and parsed args if matched.
*
* Note: If a command has `acceptsArgs: false` and the user provides arguments,
* the command will not match. This allows the message to fall through to
* built-in handlers or the agent. Document this behavior to plugin authors.
*/
function matchPluginCommand(commandBody) {
	const trimmed = commandBody.trim();
	if (!trimmed.startsWith("/")) return null;
	const spaceIndex = trimmed.indexOf(" ");
	const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const args = spaceIndex === -1 ? void 0 : trimmed.slice(spaceIndex + 1).trim();
	const key = commandName.toLowerCase();
	const command = pluginCommands.get(key);
	if (!command) return null;
	if (args && !command.acceptsArgs) return null;
	return {
		command,
		args: args || void 0
	};
}
/**
* Sanitize command arguments to prevent injection attacks.
* Removes control characters and enforces length limits.
*/
function sanitizeArgs(args) {
	if (!args) return;
	if (args.length > MAX_ARGS_LENGTH) return args.slice(0, MAX_ARGS_LENGTH);
	let sanitized = "";
	for (const char of args) {
		const code = char.charCodeAt(0);
		if (!(code <= 31 && code !== 9 && code !== 10 || code === 127)) sanitized += char;
	}
	return sanitized;
}
function stripPrefix(raw, prefix) {
	if (!raw) return;
	return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}
function resolveBindingConversationFromCommand(params) {
	const accountId = params.accountId?.trim() || "default";
	if (params.channel === "telegram") {
		const rawTarget = params.to ?? params.from;
		if (!rawTarget) return null;
		const target = parseExplicitTargetForChannel("telegram", rawTarget);
		if (!target) return null;
		return {
			channel: "telegram",
			accountId,
			conversationId: target.to,
			threadId: params.messageThreadId ?? target.threadId
		};
	}
	if (params.channel === "discord") {
		const source = params.from ?? params.to;
		const rawTarget = source?.startsWith("discord:channel:") ? stripPrefix(source, "discord:") : source?.startsWith("discord:user:") ? stripPrefix(source, "discord:") : source;
		if (!rawTarget || rawTarget.startsWith("slash:")) return null;
		const target = parseExplicitTargetForChannel("discord", rawTarget);
		if (!target) return null;
		return {
			channel: "discord",
			accountId,
			conversationId: `${target.chatType === "direct" ? "user" : "channel"}:${target.to}`
		};
	}
	return null;
}
/**
* Execute a plugin command handler.
*
* Note: Plugin authors should still validate and sanitize ctx.args for their
* specific use case. This function provides basic defense-in-depth sanitization.
*/
async function executePluginCommand(params) {
	const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;
	if (command.requireAuth !== false && !isAuthorizedSender) {
		logVerbose(`Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`);
		return { text: "⚠️ This command requires authorization." };
	}
	const sanitizedArgs = sanitizeArgs(args);
	const bindingConversation = resolveBindingConversationFromCommand({
		channel,
		from: params.from,
		to: params.to,
		accountId: params.accountId,
		messageThreadId: params.messageThreadId
	});
	const ctx = {
		senderId,
		channel,
		channelId: params.channelId,
		isAuthorizedSender,
		args: sanitizedArgs,
		commandBody,
		config,
		from: params.from,
		to: params.to,
		accountId: params.accountId,
		messageThreadId: params.messageThreadId,
		requestConversationBinding: async (bindingParams) => {
			if (!command.pluginRoot || !bindingConversation) return {
				status: "error",
				message: "This command cannot bind the current conversation."
			};
			return requestPluginConversationBinding({
				pluginId: command.pluginId,
				pluginName: command.pluginName,
				pluginRoot: command.pluginRoot,
				requestedBySenderId: senderId,
				conversation: bindingConversation,
				binding: bindingParams
			});
		},
		detachConversationBinding: async () => {
			if (!command.pluginRoot || !bindingConversation) return { removed: false };
			return detachPluginConversationBinding({
				pluginRoot: command.pluginRoot,
				conversation: bindingConversation
			});
		},
		getCurrentConversationBinding: async () => {
			if (!command.pluginRoot || !bindingConversation) return null;
			return getCurrentPluginConversationBinding({
				pluginRoot: command.pluginRoot,
				conversation: bindingConversation
			});
		}
	};
	registryLocked = true;
	try {
		const result = await command.handler(ctx);
		logVerbose(`Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`);
		return result;
	} catch (err) {
		const error = err;
		logVerbose(`Plugin command /${command.name} error: ${error.message}`);
		return { text: "⚠️ Command failed. Please try again later." };
	} finally {
		registryLocked = false;
	}
}
/**
* List all registered plugin commands.
* Used for /help and /commands output.
*/
function listPluginCommands() {
	return Array.from(pluginCommands.values()).map((cmd) => ({
		name: cmd.name,
		description: cmd.description,
		pluginId: cmd.pluginId
	}));
}
function resolvePluginNativeName(command, provider) {
	const providerName = provider?.trim().toLowerCase();
	const providerOverride = providerName ? command.nativeNames?.[providerName] : void 0;
	if (typeof providerOverride === "string" && providerOverride.trim()) return providerOverride.trim();
	const defaultOverride = command.nativeNames?.default;
	if (typeof defaultOverride === "string" && defaultOverride.trim()) return defaultOverride.trim();
	return command.name;
}
/**
* Get plugin command specs for native command registration (e.g., Telegram).
*/
function getPluginCommandSpecs(provider) {
	const providerName = provider?.trim().toLowerCase();
	if (providerName && providerName !== "telegram" && providerName !== "discord") return [];
	return Array.from(pluginCommands.values()).map((cmd) => ({
		name: resolvePluginNativeName(cmd, provider),
		description: cmd.description,
		acceptsArgs: cmd.acceptsArgs ?? false
	}));
}
var pluginCommands, registryLocked, MAX_ARGS_LENGTH, RESERVED_COMMANDS;
var init_commands = __esmMin((() => {
	init_target_parsing();
	init_globals();
	init_conversation_binding();
	pluginCommands = /* @__PURE__ */ new Map();
	registryLocked = false;
	MAX_ARGS_LENGTH = 4096;
	RESERVED_COMMANDS = new Set([
		"help",
		"commands",
		"status",
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
}));
//#endregion
//#region src/plugins/http-path.ts
function normalizePluginHttpPath(path, fallback) {
	const trimmed = path?.trim();
	if (!trimmed) {
		const fallbackTrimmed = fallback?.trim();
		if (!fallbackTrimmed) return null;
		return fallbackTrimmed.startsWith("/") ? fallbackTrimmed : `/${fallbackTrimmed}`;
	}
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
var init_http_path = __esmMin((() => {}));
//#endregion
//#region src/gateway/security-path.ts
function normalizePathSeparators(pathname) {
	const collapsed = pathname.replace(/\/{2,}/g, "/");
	if (collapsed.length <= 1) return collapsed;
	return collapsed.replace(/\/+$/, "");
}
function resolveDotSegments(pathname) {
	try {
		return new URL(pathname, "http://localhost").pathname;
	} catch {
		return pathname;
	}
}
function normalizePathForSecurity(pathname) {
	return normalizePathSeparators(resolveDotSegments(pathname).toLowerCase()) || "/";
}
function pushNormalizedCandidate(candidates, seen, value) {
	const normalized = normalizePathForSecurity(value);
	if (seen.has(normalized)) return;
	seen.add(normalized);
	candidates.push(normalized);
}
function buildCanonicalPathCandidates(pathname, maxDecodePasses = MAX_PATH_DECODE_PASSES) {
	const candidates = [];
	const seen = /* @__PURE__ */ new Set();
	pushNormalizedCandidate(candidates, seen, pathname);
	let decoded = pathname;
	let malformedEncoding = false;
	let decodePasses = 0;
	for (let pass = 0; pass < maxDecodePasses; pass++) {
		let nextDecoded = decoded;
		try {
			nextDecoded = decodeURIComponent(decoded);
		} catch {
			malformedEncoding = true;
			break;
		}
		if (nextDecoded === decoded) break;
		decodePasses += 1;
		decoded = nextDecoded;
		pushNormalizedCandidate(candidates, seen, decoded);
	}
	let decodePassLimitReached = false;
	if (!malformedEncoding) try {
		decodePassLimitReached = decodeURIComponent(decoded) !== decoded;
	} catch {
		malformedEncoding = true;
	}
	return {
		candidates,
		decodePasses,
		decodePassLimitReached,
		malformedEncoding
	};
}
function canonicalizePathVariant(pathname) {
	const { candidates } = buildCanonicalPathCandidates(pathname);
	return candidates[candidates.length - 1] ?? "/";
}
var MAX_PATH_DECODE_PASSES;
var init_security_path = __esmMin((() => {
	MAX_PATH_DECODE_PASSES = 32;
}));
//#endregion
//#region src/plugins/http-route-overlap.ts
function prefixMatchPath(pathname, prefix) {
	return pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`);
}
function doPluginHttpRoutesOverlap(a, b) {
	const aPath = canonicalizePathVariant(a.path);
	const bPath = canonicalizePathVariant(b.path);
	if (a.match === "exact" && b.match === "exact") return aPath === bPath;
	if (a.match === "prefix" && b.match === "prefix") return prefixMatchPath(aPath, bPath) || prefixMatchPath(bPath, aPath);
	const prefixRoute = a.match === "prefix" ? a : b;
	return prefixMatchPath(canonicalizePathVariant((a.match === "exact" ? a : b).path), canonicalizePathVariant(prefixRoute.path));
}
function findOverlappingPluginHttpRoute(routes, candidate) {
	return routes.find((route) => doPluginHttpRoutesOverlap(route, candidate));
}
var init_http_route_overlap = __esmMin((() => {
	init_security_path();
}));
//#endregion
//#region src/infra/map-size.ts
function pruneMapToMaxSize(map, maxSize) {
	const limit = Math.max(0, Math.floor(maxSize));
	if (limit <= 0) {
		map.clear();
		return;
	}
	while (map.size > limit) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
}
var init_map_size = __esmMin((() => {}));
//#endregion
//#region src/infra/dedupe.ts
function createDedupeCache(options) {
	const ttlMs = Math.max(0, options.ttlMs);
	const maxSize = Math.max(0, Math.floor(options.maxSize));
	const cache = /* @__PURE__ */ new Map();
	const touch = (key, now) => {
		cache.delete(key);
		cache.set(key, now);
	};
	const prune = (now) => {
		const cutoff = ttlMs > 0 ? now - ttlMs : void 0;
		if (cutoff !== void 0) {
			for (const [entryKey, entryTs] of cache) if (entryTs < cutoff) cache.delete(entryKey);
		}
		if (maxSize <= 0) {
			cache.clear();
			return;
		}
		pruneMapToMaxSize(cache, maxSize);
	};
	const hasUnexpired = (key, now, touchOnRead) => {
		const existing = cache.get(key);
		if (existing === void 0) return false;
		if (ttlMs > 0 && now - existing >= ttlMs) {
			cache.delete(key);
			return false;
		}
		if (touchOnRead) touch(key, now);
		return true;
	};
	return {
		check: (key, now = Date.now()) => {
			if (!key) return false;
			if (hasUnexpired(key, now, true)) return true;
			touch(key, now);
			prune(now);
			return false;
		},
		peek: (key, now = Date.now()) => {
			if (!key) return false;
			return hasUnexpired(key, now, false);
		},
		delete: (key) => {
			if (!key) return;
			cache.delete(key);
		},
		clear: () => {
			cache.clear();
		},
		size: () => cache.size
	};
}
var init_dedupe = __esmMin((() => {
	init_map_size();
}));
//#endregion
//#region src/plugins/interactive-dispatch-adapters.ts
function createConversationBindingHelpers(params) {
	const { registration, senderId, conversation } = params;
	const pluginRoot = registration.pluginRoot;
	return {
		requestConversationBinding: async (binding = {}) => {
			if (!pluginRoot) return {
				status: "error",
				message: "This interaction cannot bind the current conversation."
			};
			return requestPluginConversationBinding({
				pluginId: registration.pluginId,
				pluginName: registration.pluginName,
				pluginRoot,
				requestedBySenderId: senderId,
				conversation,
				binding
			});
		},
		detachConversationBinding: async () => {
			if (!pluginRoot) return { removed: false };
			return detachPluginConversationBinding({
				pluginRoot,
				conversation
			});
		},
		getCurrentConversationBinding: async () => {
			if (!pluginRoot) return null;
			return getCurrentPluginConversationBinding({
				pluginRoot,
				conversation
			});
		}
	};
}
function dispatchTelegramInteractiveHandler(params) {
	const { callbackMessage, ...handlerContext } = params.ctx;
	return params.registration.handler({
		...handlerContext,
		channel: "telegram",
		callback: {
			data: params.data,
			namespace: params.namespace,
			payload: params.payload,
			messageId: callbackMessage.messageId,
			chatId: callbackMessage.chatId,
			messageText: callbackMessage.messageText
		},
		respond: params.respond,
		...createConversationBindingHelpers({
			registration: params.registration,
			senderId: handlerContext.senderId,
			conversation: {
				channel: "telegram",
				accountId: handlerContext.accountId,
				conversationId: handlerContext.conversationId,
				parentConversationId: handlerContext.parentConversationId,
				threadId: handlerContext.threadId
			}
		})
	});
}
function dispatchDiscordInteractiveHandler(params) {
	const handlerContext = params.ctx;
	return params.registration.handler({
		...handlerContext,
		channel: "discord",
		interaction: {
			...handlerContext.interaction,
			data: params.data,
			namespace: params.namespace,
			payload: params.payload
		},
		respond: params.respond,
		...createConversationBindingHelpers({
			registration: params.registration,
			senderId: handlerContext.senderId,
			conversation: {
				channel: "discord",
				accountId: handlerContext.accountId,
				conversationId: handlerContext.conversationId,
				parentConversationId: handlerContext.parentConversationId
			}
		})
	});
}
function dispatchSlackInteractiveHandler(params) {
	const handlerContext = params.ctx;
	return params.registration.handler({
		...handlerContext,
		channel: "slack",
		interaction: {
			...handlerContext.interaction,
			data: params.data,
			namespace: params.namespace,
			payload: params.payload
		},
		respond: params.respond,
		...createConversationBindingHelpers({
			registration: params.registration,
			senderId: handlerContext.senderId,
			conversation: {
				channel: "slack",
				accountId: handlerContext.accountId,
				conversationId: handlerContext.conversationId,
				parentConversationId: handlerContext.parentConversationId,
				threadId: handlerContext.threadId
			}
		})
	});
}
var init_interactive_dispatch_adapters = __esmMin((() => {
	init_conversation_binding();
}));
//#endregion
//#region src/plugins/interactive.ts
function toRegistryKey(channel, namespace) {
	return `${channel.trim().toLowerCase()}:${namespace.trim()}`;
}
function normalizeNamespace(namespace) {
	return namespace.trim();
}
function validateNamespace(namespace) {
	if (!namespace.trim()) return "Interactive handler namespace cannot be empty";
	if (!/^[A-Za-z0-9._-]+$/.test(namespace.trim())) return "Interactive handler namespace must contain only letters, numbers, dots, underscores, and hyphens";
	return null;
}
function resolveNamespaceMatch(channel, data) {
	const trimmedData = data.trim();
	if (!trimmedData) return null;
	const separatorIndex = trimmedData.indexOf(":");
	const namespace = separatorIndex >= 0 ? trimmedData.slice(0, separatorIndex) : normalizeNamespace(trimmedData);
	const registration = interactiveHandlers.get(toRegistryKey(channel, namespace));
	if (!registration) return null;
	return {
		registration,
		namespace,
		payload: separatorIndex >= 0 ? trimmedData.slice(separatorIndex + 1) : ""
	};
}
function registerPluginInteractiveHandler(pluginId, registration, opts) {
	const namespace = normalizeNamespace(registration.namespace);
	const validationError = validateNamespace(namespace);
	if (validationError) return {
		ok: false,
		error: validationError
	};
	const key = toRegistryKey(registration.channel, namespace);
	const existing = interactiveHandlers.get(key);
	if (existing) return {
		ok: false,
		error: `Interactive handler namespace "${namespace}" already registered by plugin "${existing.pluginId}"`
	};
	if (registration.channel === "telegram") interactiveHandlers.set(key, {
		...registration,
		namespace,
		channel: "telegram",
		pluginId,
		pluginName: opts?.pluginName,
		pluginRoot: opts?.pluginRoot
	});
	else if (registration.channel === "slack") interactiveHandlers.set(key, {
		...registration,
		namespace,
		channel: "slack",
		pluginId,
		pluginName: opts?.pluginName,
		pluginRoot: opts?.pluginRoot
	});
	else interactiveHandlers.set(key, {
		...registration,
		namespace,
		channel: "discord",
		pluginId,
		pluginName: opts?.pluginName,
		pluginRoot: opts?.pluginRoot
	});
	return { ok: true };
}
function clearPluginInteractiveHandlers() {
	interactiveHandlers.clear();
	callbackDedupe.clear();
}
async function dispatchPluginInteractiveHandler(params) {
	const match = resolveNamespaceMatch(params.channel, params.data);
	if (!match) return {
		matched: false,
		handled: false,
		duplicate: false
	};
	const dedupeKey = params.channel === "telegram" ? params.callbackId?.trim() : params.interactionId?.trim();
	if (dedupeKey && callbackDedupe.peek(dedupeKey)) return {
		matched: true,
		handled: true,
		duplicate: true
	};
	let result;
	if (params.channel === "telegram") result = dispatchTelegramInteractiveHandler({
		registration: match.registration,
		data: params.data,
		namespace: match.namespace,
		payload: match.payload,
		ctx: params.ctx,
		respond: params.respond
	});
	else if (params.channel === "discord") result = dispatchDiscordInteractiveHandler({
		registration: match.registration,
		data: params.data,
		namespace: match.namespace,
		payload: match.payload,
		ctx: params.ctx,
		respond: params.respond
	});
	else result = dispatchSlackInteractiveHandler({
		registration: match.registration,
		data: params.data,
		namespace: match.namespace,
		payload: match.payload,
		ctx: params.ctx,
		respond: params.respond
	});
	const resolved = await result;
	if (dedupeKey) callbackDedupe.check(dedupeKey);
	return {
		matched: true,
		handled: resolved?.handled ?? true,
		duplicate: false
	};
}
var interactiveHandlers, callbackDedupe;
var init_interactive = __esmMin((() => {
	init_dedupe();
	init_interactive_dispatch_adapters();
	interactiveHandlers = /* @__PURE__ */ new Map();
	callbackDedupe = createDedupeCache({
		ttlMs: 5 * 6e4,
		maxSize: 4096
	});
}));
//#endregion
//#region src/plugins/provider-validation.ts
function pushProviderDiagnostic(params) {
	params.pushDiagnostic({
		level: params.level,
		pluginId: params.pluginId,
		source: params.source,
		message: params.message
	});
}
function normalizeText(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function normalizeTextList(values) {
	const normalized = Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeProviderWizardSetup(params) {
	const hasAuthMethods = params.auth.length > 0;
	if (!params.setup) return;
	if (!hasAuthMethods) {
		pushProviderDiagnostic({
			level: "warn",
			pluginId: params.pluginId,
			source: params.source,
			message: `provider "${params.providerId}" setup metadata ignored because it has no auth methods`,
			pushDiagnostic: params.pushDiagnostic
		});
		return;
	}
	const methodId = normalizeText(params.setup.methodId);
	if (methodId && !params.auth.some((method) => method.id === methodId)) pushProviderDiagnostic({
		level: "warn",
		pluginId: params.pluginId,
		source: params.source,
		message: `provider "${params.providerId}" setup method "${methodId}" not found; falling back to available methods`,
		pushDiagnostic: params.pushDiagnostic
	});
	return {
		...normalizeText(params.setup.choiceId) ? { choiceId: normalizeText(params.setup.choiceId) } : {},
		...normalizeText(params.setup.choiceLabel) ? { choiceLabel: normalizeText(params.setup.choiceLabel) } : {},
		...normalizeText(params.setup.choiceHint) ? { choiceHint: normalizeText(params.setup.choiceHint) } : {},
		...normalizeText(params.setup.groupId) ? { groupId: normalizeText(params.setup.groupId) } : {},
		...normalizeText(params.setup.groupLabel) ? { groupLabel: normalizeText(params.setup.groupLabel) } : {},
		...normalizeText(params.setup.groupHint) ? { groupHint: normalizeText(params.setup.groupHint) } : {},
		...methodId && params.auth.some((method) => method.id === methodId) ? { methodId } : {},
		...params.setup.modelAllowlist ? { modelAllowlist: {
			...normalizeTextList(params.setup.modelAllowlist.allowedKeys) ? { allowedKeys: normalizeTextList(params.setup.modelAllowlist.allowedKeys) } : {},
			...normalizeTextList(params.setup.modelAllowlist.initialSelections) ? { initialSelections: normalizeTextList(params.setup.modelAllowlist.initialSelections) } : {},
			...normalizeText(params.setup.modelAllowlist.message) ? { message: normalizeText(params.setup.modelAllowlist.message) } : {}
		} } : {}
	};
}
function normalizeProviderAuthMethods(params) {
	const seenMethodIds = /* @__PURE__ */ new Set();
	const normalized = [];
	for (const method of params.auth) {
		const methodId = normalizeText(method.id);
		if (!methodId) {
			pushProviderDiagnostic({
				level: "error",
				pluginId: params.pluginId,
				source: params.source,
				message: `provider "${params.providerId}" auth method missing id`,
				pushDiagnostic: params.pushDiagnostic
			});
			continue;
		}
		if (seenMethodIds.has(methodId)) {
			pushProviderDiagnostic({
				level: "error",
				pluginId: params.pluginId,
				source: params.source,
				message: `provider "${params.providerId}" auth method duplicated id "${methodId}"`,
				pushDiagnostic: params.pushDiagnostic
			});
			continue;
		}
		seenMethodIds.add(methodId);
		const wizard = normalizeProviderWizardSetup({
			providerId: params.providerId,
			pluginId: params.pluginId,
			source: params.source,
			auth: [{
				...method,
				id: methodId
			}],
			setup: method.wizard,
			pushDiagnostic: params.pushDiagnostic
		});
		normalized.push({
			...method,
			id: methodId,
			label: normalizeText(method.label) ?? methodId,
			...normalizeText(method.hint) ? { hint: normalizeText(method.hint) } : {},
			...wizard ? { wizard } : {}
		});
	}
	return normalized;
}
function normalizeProviderWizard(params) {
	if (!params.wizard) return;
	const hasAuthMethods = params.auth.length > 0;
	const hasMethod = (methodId) => Boolean(methodId && params.auth.some((method) => method.id === methodId));
	const normalizeSetup = () => {
		const setup = params.wizard?.setup;
		if (!setup) return;
		return normalizeProviderWizardSetup({
			providerId: params.providerId,
			pluginId: params.pluginId,
			source: params.source,
			auth: params.auth,
			setup,
			pushDiagnostic: params.pushDiagnostic
		});
	};
	const normalizeModelPicker = () => {
		const modelPicker = params.wizard?.modelPicker;
		if (!modelPicker) return;
		if (!hasAuthMethods) {
			pushProviderDiagnostic({
				level: "warn",
				pluginId: params.pluginId,
				source: params.source,
				message: `provider "${params.providerId}" model-picker metadata ignored because it has no auth methods`,
				pushDiagnostic: params.pushDiagnostic
			});
			return;
		}
		const methodId = normalizeText(modelPicker.methodId);
		if (methodId && !hasMethod(methodId)) pushProviderDiagnostic({
			level: "warn",
			pluginId: params.pluginId,
			source: params.source,
			message: `provider "${params.providerId}" model-picker method "${methodId}" not found; falling back to available methods`,
			pushDiagnostic: params.pushDiagnostic
		});
		return {
			...normalizeText(modelPicker.label) ? { label: normalizeText(modelPicker.label) } : {},
			...normalizeText(modelPicker.hint) ? { hint: normalizeText(modelPicker.hint) } : {},
			...methodId && hasMethod(methodId) ? { methodId } : {}
		};
	};
	const setup = normalizeSetup();
	const modelPicker = normalizeModelPicker();
	if (!setup && !modelPicker) return;
	return {
		...setup ? { setup } : {},
		...modelPicker ? { modelPicker } : {}
	};
}
function normalizeRegisteredProvider(params) {
	const id = normalizeText(params.provider.id);
	if (!id) {
		pushProviderDiagnostic({
			level: "error",
			pluginId: params.pluginId,
			source: params.source,
			message: "provider registration missing id",
			pushDiagnostic: params.pushDiagnostic
		});
		return null;
	}
	const auth = normalizeProviderAuthMethods({
		providerId: id,
		pluginId: params.pluginId,
		source: params.source,
		auth: params.provider.auth ?? [],
		pushDiagnostic: params.pushDiagnostic
	});
	const docsPath = normalizeText(params.provider.docsPath);
	const aliases = normalizeTextList(params.provider.aliases);
	const deprecatedProfileIds = normalizeTextList(params.provider.deprecatedProfileIds);
	const envVars = normalizeTextList(params.provider.envVars);
	const wizard = normalizeProviderWizard({
		providerId: id,
		pluginId: params.pluginId,
		source: params.source,
		auth,
		wizard: params.provider.wizard,
		pushDiagnostic: params.pushDiagnostic
	});
	const catalog = params.provider.catalog;
	const discovery = params.provider.discovery;
	if (catalog && discovery) pushProviderDiagnostic({
		level: "warn",
		pluginId: params.pluginId,
		source: params.source,
		message: `provider "${id}" registered both catalog and discovery; using catalog`,
		pushDiagnostic: params.pushDiagnostic
	});
	const { wizard: _ignoredWizard, docsPath: _ignoredDocsPath, aliases: _ignoredAliases, envVars: _ignoredEnvVars, catalog: _ignoredCatalog, discovery: _ignoredDiscovery, ...restProvider } = params.provider;
	return {
		...restProvider,
		id,
		label: normalizeText(params.provider.label) ?? id,
		...docsPath ? { docsPath } : {},
		...aliases ? { aliases } : {},
		...deprecatedProfileIds ? { deprecatedProfileIds } : {},
		...envVars ? { envVars } : {},
		auth,
		...catalog ? { catalog } : {},
		...!catalog && discovery ? { discovery } : {},
		...wizard ? { wizard } : {}
	};
}
var init_provider_validation = __esmMin((() => {}));
//#endregion
//#region src/plugins/types.ts
var PLUGIN_HOOK_NAMES, pluginHookNameSet, isPluginHookName, PROMPT_INJECTION_HOOK_NAMES, promptInjectionHookNameSet, isPromptInjectionHookName, PLUGIN_PROMPT_MUTATION_RESULT_FIELDS, stripPromptMutationFieldsFromLegacyHookResult;
var init_types = __esmMin((() => {
	PLUGIN_HOOK_NAMES = [
		"before_model_resolve",
		"before_prompt_build",
		"before_agent_start",
		"llm_input",
		"llm_output",
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
		"gateway_stop"
	];
	pluginHookNameSet = new Set(PLUGIN_HOOK_NAMES);
	isPluginHookName = (hookName) => typeof hookName === "string" && pluginHookNameSet.has(hookName);
	PROMPT_INJECTION_HOOK_NAMES = ["before_prompt_build", "before_agent_start"];
	promptInjectionHookNameSet = new Set(PROMPT_INJECTION_HOOK_NAMES);
	isPromptInjectionHookName = (hookName) => promptInjectionHookNameSet.has(hookName);
	PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = [
		"systemPrompt",
		"prependContext",
		"prependSystemContext",
		"appendSystemContext"
	];
	stripPromptMutationFieldsFromLegacyHookResult = (result) => {
		if (!result || typeof result !== "object") return result;
		const remaining = { ...result };
		for (const field of PLUGIN_PROMPT_MUTATION_RESULT_FIELDS) delete remaining[field];
		return Object.keys(remaining).length > 0 ? remaining : void 0;
	};
}));
//#endregion
//#region src/plugins/registry.ts
function createEmptyPluginRegistry() {
	return {
		plugins: [],
		tools: [],
		hooks: [],
		typedHooks: [],
		channels: [],
		channelSetups: [],
		providers: [],
		webSearchProviders: [],
		gatewayHandlers: {},
		httpRoutes: [],
		cliRegistrars: [],
		services: [],
		commands: [],
		diagnostics: []
	};
}
function createPluginRegistry(registryParams) {
	const registry = createEmptyPluginRegistry();
	const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));
	const pushDiagnostic = (diag) => {
		registry.diagnostics.push(diag);
	};
	const registerTool = (record, tool, opts) => {
		const names = opts?.names ?? (opts?.name ? [opts.name] : []);
		const optional = opts?.optional === true;
		const factory = typeof tool === "function" ? tool : (_ctx) => tool;
		if (typeof tool !== "function") names.push(tool.name);
		const normalized = names.map((name) => name.trim()).filter(Boolean);
		if (normalized.length > 0) record.toolNames.push(...normalized);
		registry.tools.push({
			pluginId: record.id,
			pluginName: record.name,
			factory,
			names: normalized,
			optional,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerHook = (record, events, handler, opts, config) => {
		const normalizedEvents = (Array.isArray(events) ? events : [events]).map((event) => event.trim()).filter(Boolean);
		const entry = opts?.entry ?? null;
		const name = entry?.hook.name ?? opts?.name?.trim();
		if (!name) {
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: "hook registration missing name"
			});
			return;
		}
		const existingHook = registry.hooks.find((entry) => entry.entry.hook.name === name);
		if (existingHook) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `hook already registered: ${name} (${existingHook.pluginId})`
			});
			return;
		}
		const description = entry?.hook.description ?? opts?.description ?? "";
		const hookEntry = entry ? {
			...entry,
			hook: {
				...entry.hook,
				name,
				description,
				source: "openclaw-plugin",
				pluginId: record.id
			},
			metadata: {
				...entry.metadata,
				events: normalizedEvents
			}
		} : {
			hook: {
				name,
				description,
				source: "openclaw-plugin",
				pluginId: record.id,
				filePath: record.source,
				baseDir: path.dirname(record.source),
				handlerPath: record.source
			},
			frontmatter: {},
			metadata: { events: normalizedEvents },
			invocation: { enabled: true }
		};
		record.hookNames.push(name);
		registry.hooks.push({
			pluginId: record.id,
			entry: hookEntry,
			events: normalizedEvents,
			source: record.source
		});
		if (!(config?.hooks?.internal?.enabled === true) || opts?.register === false) return;
		for (const event of normalizedEvents) registerInternalHook(event, handler);
	};
	const registerGatewayMethod = (record, method, handler) => {
		const trimmed = method.trim();
		if (!trimmed) return;
		if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `gateway method already registered: ${trimmed}`
			});
			return;
		}
		registry.gatewayHandlers[trimmed] = handler;
		record.gatewayMethods.push(trimmed);
	};
	const describeHttpRouteOwner = (entry) => {
		return `${entry.pluginId?.trim() || "unknown-plugin"} (${entry.source?.trim() || "unknown-source"})`;
	};
	const registerHttpRoute = (record, params) => {
		const normalizedPath = normalizePluginHttpPath(params.path);
		if (!normalizedPath) {
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: "http route registration missing path"
			});
			return;
		}
		if (params.auth !== "gateway" && params.auth !== "plugin") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `http route registration missing or invalid auth: ${normalizedPath}`
			});
			return;
		}
		const match = params.match ?? "exact";
		const overlappingRoute = findOverlappingPluginHttpRoute(registry.httpRoutes, {
			path: normalizedPath,
			match
		});
		if (overlappingRoute && overlappingRoute.auth !== params.auth) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `http route overlap rejected: ${normalizedPath} (${match}, ${params.auth}) overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) owned by ${describeHttpRouteOwner(overlappingRoute)}`
			});
			return;
		}
		const existingIndex = registry.httpRoutes.findIndex((entry) => entry.path === normalizedPath && entry.match === match);
		if (existingIndex >= 0) {
			const existing = registry.httpRoutes[existingIndex];
			if (!existing) return;
			if (!params.replaceExisting) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(existing)}`
				});
				return;
			}
			if (existing.pluginId && existing.pluginId !== record.id) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(existing)}`
				});
				return;
			}
			registry.httpRoutes[existingIndex] = {
				pluginId: record.id,
				path: normalizedPath,
				handler: params.handler,
				auth: params.auth,
				match,
				source: record.source
			};
			return;
		}
		record.httpRoutes += 1;
		registry.httpRoutes.push({
			pluginId: record.id,
			path: normalizedPath,
			handler: params.handler,
			auth: params.auth,
			match,
			source: record.source
		});
	};
	const registerChannel = (record, registration, mode = "full") => {
		const plugin = (typeof registration.plugin === "object" ? registration : { plugin: registration }).plugin;
		const id = typeof plugin?.id === "string" ? plugin.id.trim() : String(plugin?.id ?? "").trim();
		if (!id) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "channel registration missing id"
			});
			return;
		}
		const existingRuntime = registry.channels.find((entry) => entry.plugin.id === id);
		if (mode !== "setup-only" && existingRuntime) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `channel already registered: ${id} (${existingRuntime.pluginId})`
			});
			return;
		}
		const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
		if (existingSetup) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `channel setup already registered: ${id} (${existingSetup.pluginId})`
			});
			return;
		}
		record.channelIds.push(id);
		registry.channelSetups.push({
			pluginId: record.id,
			pluginName: record.name,
			plugin,
			source: record.source,
			enabled: record.enabled,
			rootDir: record.rootDir
		});
		if (mode === "setup-only") return;
		registry.channels.push({
			pluginId: record.id,
			pluginName: record.name,
			plugin,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerProvider = (record, provider) => {
		const normalizedProvider = normalizeRegisteredProvider({
			pluginId: record.id,
			source: record.source,
			provider,
			pushDiagnostic
		});
		if (!normalizedProvider) return;
		const id = normalizedProvider.id;
		const existing = registry.providers.find((entry) => entry.provider.id === id);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `provider already registered: ${id} (${existing.pluginId})`
			});
			return;
		}
		record.providerIds.push(id);
		registry.providers.push({
			pluginId: record.id,
			pluginName: record.name,
			provider: normalizedProvider,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerWebSearchProvider = (record, provider) => {
		const id = provider.id.trim();
		if (!id) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "web search provider registration missing id"
			});
			return;
		}
		const existing = registry.webSearchProviders.find((entry) => entry.provider.id === id);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `web search provider already registered: ${id} (${existing.pluginId})`
			});
			return;
		}
		record.webSearchProviderIds.push(id);
		registry.webSearchProviders.push({
			pluginId: record.id,
			pluginName: record.name,
			provider,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerCli = (record, registrar, opts) => {
		const commands = (opts?.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
		if (commands.length === 0) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "cli registration missing explicit commands metadata"
			});
			return;
		}
		const existing = registry.cliRegistrars.find((entry) => entry.commands.some((command) => commands.includes(command)));
		if (existing) {
			const overlap = commands.find((command) => existing.commands.includes(command));
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `cli command already registered: ${overlap ?? commands[0]} (${existing.pluginId})`
			});
			return;
		}
		record.cliCommands.push(...commands);
		registry.cliRegistrars.push({
			pluginId: record.id,
			pluginName: record.name,
			register: registrar,
			commands,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerService = (record, service) => {
		const id = service.id.trim();
		if (!id) return;
		const existing = registry.services.find((entry) => entry.service.id === id);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `service already registered: ${id} (${existing.pluginId})`
			});
			return;
		}
		record.services.push(id);
		registry.services.push({
			pluginId: record.id,
			pluginName: record.name,
			service,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerCommand = (record, command) => {
		const name = command.name.trim();
		if (!name) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "command registration missing name"
			});
			return;
		}
		if (registryParams.suppressGlobalCommands) {
			const validationError = validatePluginCommandDefinition(command);
			if (validationError) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `command registration failed: ${validationError}`
				});
				return;
			}
		} else {
			const result = registerPluginCommand(record.id, command, {
				pluginName: record.name,
				pluginRoot: record.rootDir
			});
			if (!result.ok) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `command registration failed: ${result.error}`
				});
				return;
			}
		}
		record.commands.push(name);
		registry.commands.push({
			pluginId: record.id,
			pluginName: record.name,
			command,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerTypedHook = (record, hookName, handler, opts, policy) => {
		if (!isPluginHookName(hookName)) {
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: `unknown typed hook "${String(hookName)}" ignored`
			});
			return;
		}
		let effectiveHandler = handler;
		if (policy?.allowPromptInjection === false && isPromptInjectionHookName(hookName)) {
			if (hookName === "before_prompt_build") {
				pushDiagnostic({
					level: "warn",
					pluginId: record.id,
					source: record.source,
					message: `typed hook "${hookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`
				});
				return;
			}
			if (hookName === "before_agent_start") {
				pushDiagnostic({
					level: "warn",
					pluginId: record.id,
					source: record.source,
					message: `typed hook "${hookName}" prompt fields constrained by plugins.entries.${record.id}.hooks.allowPromptInjection=false`
				});
				effectiveHandler = constrainLegacyPromptInjectionHook(handler);
			}
		}
		record.hookCount += 1;
		registry.typedHooks.push({
			pluginId: record.id,
			hookName,
			handler: effectiveHandler,
			priority: opts?.priority,
			source: record.source
		});
	};
	const normalizeLogger = (logger) => ({
		info: logger.info,
		warn: logger.warn,
		error: logger.error,
		debug: logger.debug
	});
	const createApi = (record, params) => {
		const registrationMode = params.registrationMode ?? "full";
		return {
			id: record.id,
			name: record.name,
			version: record.version,
			description: record.description,
			source: record.source,
			rootDir: record.rootDir,
			registrationMode,
			config: params.config,
			pluginConfig: params.pluginConfig,
			runtime: registryParams.runtime,
			logger: normalizeLogger(registryParams.logger),
			registerTool: registrationMode === "full" ? (tool, opts) => registerTool(record, tool, opts) : () => {},
			registerHook: registrationMode === "full" ? (events, handler, opts) => registerHook(record, events, handler, opts, params.config) : () => {},
			registerHttpRoute: registrationMode === "full" ? (params) => registerHttpRoute(record, params) : () => {},
			registerChannel: (registration) => registerChannel(record, registration, registrationMode),
			registerProvider: registrationMode === "full" ? (provider) => registerProvider(record, provider) : () => {},
			registerWebSearchProvider: registrationMode === "full" ? (provider) => registerWebSearchProvider(record, provider) : () => {},
			registerGatewayMethod: registrationMode === "full" ? (method, handler) => registerGatewayMethod(record, method, handler) : () => {},
			registerCli: registrationMode === "full" ? (registrar, opts) => registerCli(record, registrar, opts) : () => {},
			registerService: registrationMode === "full" ? (service) => registerService(record, service) : () => {},
			registerInteractiveHandler: registrationMode === "full" ? (registration) => {
				const result = registerPluginInteractiveHandler(record.id, registration, {
					pluginName: record.name,
					pluginRoot: record.rootDir
				});
				if (!result.ok) pushDiagnostic({
					level: "warn",
					pluginId: record.id,
					source: record.source,
					message: result.error ?? "interactive handler registration failed"
				});
			} : () => {},
			registerCommand: registrationMode === "full" ? (command) => registerCommand(record, command) : () => {},
			registerContextEngine: (id, factory) => {
				if (registrationMode !== "full") return;
				if (id === defaultSlotIdForKey("contextEngine")) {
					pushDiagnostic({
						level: "error",
						pluginId: record.id,
						source: record.source,
						message: `context engine id reserved by core: ${id}`
					});
					return;
				}
				const result = registerContextEngineForOwner(id, factory, `plugin:${record.id}`, { allowSameOwnerRefresh: true });
				if (!result.ok) pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `context engine already registered: ${id} (${result.existingOwner})`
				});
			},
			resolvePath: (input) => resolveUserPath(input),
			on: (hookName, handler, opts) => registrationMode === "full" ? registerTypedHook(record, hookName, handler, opts, params.hookPolicy) : void 0
		};
	};
	return {
		registry,
		createApi,
		pushDiagnostic,
		registerTool,
		registerChannel,
		registerProvider,
		registerWebSearchProvider,
		registerGatewayMethod,
		registerCli,
		registerService,
		registerCommand,
		registerHook,
		registerTypedHook
	};
}
var constrainLegacyPromptInjectionHook;
var init_registry$1 = __esmMin((() => {
	init_registry$3();
	init_internal_hooks();
	init_utils();
	init_commands();
	init_http_path();
	init_http_route_overlap();
	init_interactive();
	init_provider_validation();
	init_slots();
	init_types();
	constrainLegacyPromptInjectionHook = (handler) => {
		return (event, ctx) => {
			const result = handler(event, ctx);
			if (result && typeof result === "object" && "then" in result) return Promise.resolve(result).then((resolved) => stripPromptMutationFieldsFromLegacyHookResult(resolved));
			return stripPromptMutationFieldsFromLegacyHookResult(result);
		};
	};
}));
//#endregion
//#region src/plugins/runtime.ts
function setActivePluginRegistry(registry, cacheKey) {
	state.registry = registry;
	if (!state.httpRouteRegistryPinned) state.httpRouteRegistry = registry;
	state.key = cacheKey ?? null;
	state.version += 1;
}
function getActivePluginRegistry() {
	return state.registry;
}
function requireActivePluginRegistry() {
	if (!state.registry) {
		state.registry = createEmptyPluginRegistry();
		if (!state.httpRouteRegistryPinned) state.httpRouteRegistry = state.registry;
		state.version += 1;
	}
	return state.registry;
}
function getActivePluginHttpRouteRegistry() {
	return state.httpRouteRegistry ?? state.registry;
}
function requireActivePluginHttpRouteRegistry() {
	const existing = getActivePluginHttpRouteRegistry();
	if (existing) return existing;
	const created = requireActivePluginRegistry();
	state.httpRouteRegistry = created;
	return created;
}
function getActivePluginRegistryKey() {
	return state.key;
}
function getActivePluginRegistryVersion() {
	return state.version;
}
var REGISTRY_STATE, state;
var init_runtime = __esmMin((() => {
	init_registry$1();
	REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
	state = (() => {
		const globalState = globalThis;
		if (!globalState[REGISTRY_STATE]) globalState[REGISTRY_STATE] = {
			registry: createEmptyPluginRegistry(),
			httpRouteRegistry: null,
			httpRouteRegistryPinned: false,
			key: null,
			version: 0
		};
		return globalState[REGISTRY_STATE];
	})();
}));
//#endregion
//#region src/channels/registry.ts
var registry_exports = /* @__PURE__ */ __exportAll({
	CHANNEL_IDS: () => CHANNEL_IDS,
	CHAT_CHANNEL_ALIASES: () => CHAT_CHANNEL_ALIASES,
	CHAT_CHANNEL_ORDER: () => CHAT_CHANNEL_ORDER,
	formatChannelPrimerLine: () => formatChannelPrimerLine,
	formatChannelSelectionLine: () => formatChannelSelectionLine,
	getChatChannelMeta: () => getChatChannelMeta,
	listChatChannelAliases: () => listChatChannelAliases,
	listChatChannels: () => listChatChannels,
	normalizeAnyChannelId: () => normalizeAnyChannelId,
	normalizeChannelId: () => normalizeChannelId,
	normalizeChatChannelId: () => normalizeChatChannelId
});
function listChatChannels() {
	return CHAT_CHANNEL_ORDER.map((id) => CHAT_CHANNEL_META[id]);
}
function listChatChannelAliases() {
	return Object.keys(CHAT_CHANNEL_ALIASES);
}
function getChatChannelMeta(id) {
	return CHAT_CHANNEL_META[id];
}
function normalizeChatChannelId(raw) {
	const normalized = normalizeChannelKey(raw);
	if (!normalized) return null;
	const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
	return CHAT_CHANNEL_ORDER.includes(resolved) ? resolved : null;
}
function normalizeChannelId(raw) {
	return normalizeChatChannelId(raw);
}
function normalizeAnyChannelId(raw) {
	const key = normalizeChannelKey(raw);
	if (!key) return null;
	return requireActivePluginRegistry().channels.find((entry) => {
		const id = String(entry.plugin.id ?? "").trim().toLowerCase();
		if (id && id === key) return true;
		return (entry.plugin.meta.aliases ?? []).some((alias) => alias.trim().toLowerCase() === key);
	})?.plugin.id ?? null;
}
function formatChannelPrimerLine(meta) {
	return `${meta.label}: ${meta.blurb}`;
}
function formatChannelSelectionLine(meta, docsLink) {
	const docsPrefix = meta.selectionDocsPrefix ?? "Docs:";
	const docsLabel = meta.docsLabel ?? meta.id;
	const docs = meta.selectionDocsOmitLabel ? docsLink(meta.docsPath) : docsLink(meta.docsPath, docsLabel);
	const extras = (meta.selectionExtras ?? []).filter(Boolean).join(" ");
	return `${meta.label} — ${meta.blurb} ${docsPrefix ? `${docsPrefix} ` : ""}${docs}${extras ? ` ${extras}` : ""}`;
}
var CHAT_CHANNEL_ORDER, CHANNEL_IDS, CHAT_CHANNEL_META, CHAT_CHANNEL_ALIASES, normalizeChannelKey;
var init_registry = __esmMin((() => {
	init_runtime();
	CHAT_CHANNEL_ORDER = [
		"telegram",
		"whatsapp",
		"discord",
		"irc",
		"googlechat",
		"slack",
		"signal",
		"imessage",
		"line"
	];
	CHANNEL_IDS = [...CHAT_CHANNEL_ORDER];
	CHAT_CHANNEL_META = {
		telegram: {
			id: "telegram",
			label: "Telegram",
			selectionLabel: "Telegram (Bot API)",
			detailLabel: "Telegram Bot",
			docsPath: "/channels/telegram",
			docsLabel: "telegram",
			blurb: "simplest way to get started — register a bot with @BotFather and get going.",
			systemImage: "paperplane",
			selectionDocsPrefix: "",
			selectionDocsOmitLabel: true,
			selectionExtras: ["https://openclaw.ai"]
		},
		whatsapp: {
			id: "whatsapp",
			label: "WhatsApp",
			selectionLabel: "WhatsApp (QR link)",
			detailLabel: "WhatsApp Web",
			docsPath: "/channels/whatsapp",
			docsLabel: "whatsapp",
			blurb: "works with your own number; recommend a separate phone + eSIM.",
			systemImage: "message"
		},
		discord: {
			id: "discord",
			label: "Discord",
			selectionLabel: "Discord (Bot API)",
			detailLabel: "Discord Bot",
			docsPath: "/channels/discord",
			docsLabel: "discord",
			blurb: "very well supported right now.",
			systemImage: "bubble.left.and.bubble.right"
		},
		irc: {
			id: "irc",
			label: "IRC",
			selectionLabel: "IRC (Server + Nick)",
			detailLabel: "IRC",
			docsPath: "/channels/irc",
			docsLabel: "irc",
			blurb: "classic IRC networks with DM/channel routing and pairing controls.",
			systemImage: "network"
		},
		googlechat: {
			id: "googlechat",
			label: "Google Chat",
			selectionLabel: "Google Chat (Chat API)",
			detailLabel: "Google Chat",
			docsPath: "/channels/googlechat",
			docsLabel: "googlechat",
			blurb: "Google Workspace Chat app with HTTP webhook.",
			systemImage: "message.badge"
		},
		slack: {
			id: "slack",
			label: "Slack",
			selectionLabel: "Slack (Socket Mode)",
			detailLabel: "Slack Bot",
			docsPath: "/channels/slack",
			docsLabel: "slack",
			blurb: "supported (Socket Mode).",
			systemImage: "number"
		},
		signal: {
			id: "signal",
			label: "Signal",
			selectionLabel: "Signal (signal-cli)",
			detailLabel: "Signal REST",
			docsPath: "/channels/signal",
			docsLabel: "signal",
			blurb: "signal-cli linked device; more setup (David Reagans: \"Hop on Discord.\").",
			systemImage: "antenna.radiowaves.left.and.right"
		},
		imessage: {
			id: "imessage",
			label: "iMessage",
			selectionLabel: "iMessage (imsg)",
			detailLabel: "iMessage",
			docsPath: "/channels/imessage",
			docsLabel: "imessage",
			blurb: "this is still a work in progress.",
			systemImage: "message.fill"
		},
		line: {
			id: "line",
			label: "LINE",
			selectionLabel: "LINE (Messaging API)",
			detailLabel: "LINE Bot",
			docsPath: "/channels/line",
			docsLabel: "line",
			blurb: "LINE Messaging API webhook bot.",
			systemImage: "message"
		}
	};
	CHAT_CHANNEL_ALIASES = {
		imsg: "imessage",
		"internet-relay-chat": "irc",
		"google-chat": "googlechat",
		gchat: "googlechat"
	};
	normalizeChannelKey = (raw) => {
		return raw?.trim().toLowerCase() || void 0;
	};
}));
//#endregion
//#region src/plugin-sdk/channel-plugin-common.ts
init_session_key();
init_registry();
//#endregion
//#region src/infra/secret-file.ts
init_utils();
function loadSecretFileSync(filePath, label, options = {}) {
	const resolvedPath = resolveUserPath(filePath.trim());
	if (!resolvedPath) return {
		ok: false,
		message: `${label} file path is empty.`
	};
	const maxBytes = options.maxBytes ?? 16384;
	let previewStat;
	try {
		previewStat = fs.lstatSync(resolvedPath);
	} catch (error) {
		return {
			ok: false,
			resolvedPath,
			error,
			message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(error)}`
		};
	}
	if (options.rejectSymlink && previewStat.isSymbolicLink()) return {
		ok: false,
		resolvedPath,
		message: `${label} file at ${resolvedPath} must not be a symlink.`
	};
	if (!previewStat.isFile()) return {
		ok: false,
		resolvedPath,
		message: `${label} file at ${resolvedPath} must be a regular file.`
	};
	if (previewStat.size > maxBytes) return {
		ok: false,
		resolvedPath,
		message: `${label} file at ${resolvedPath} exceeds ${maxBytes} bytes.`
	};
	const opened = openVerifiedFileSync({
		filePath: resolvedPath,
		rejectPathSymlink: options.rejectSymlink,
		maxBytes
	});
	if (!opened.ok) {
		const error = opened.reason === "validation" ? /* @__PURE__ */ new Error("security validation failed") : opened.error;
		return {
			ok: false,
			resolvedPath,
			error,
			message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`
		};
	}
	try {
		const secret = fs.readFileSync(opened.fd, "utf8").trim();
		if (!secret) return {
			ok: false,
			resolvedPath,
			message: `${label} file at ${resolvedPath} is empty.`
		};
		return {
			ok: true,
			secret,
			resolvedPath
		};
	} catch (error) {
		return {
			ok: false,
			resolvedPath,
			error,
			message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`
		};
	} finally {
		fs.closeSync(opened.fd);
	}
}
function tryReadSecretFileSync(filePath, label, options = {}) {
	if (!filePath?.trim()) return;
	const result = loadSecretFileSync(filePath, label, options);
	return result.ok ? result.secret : void 0;
}
//#endregion
//#region src/channels/chat-type.ts
function normalizeChatType(raw) {
	const value = raw?.trim().toLowerCase();
	if (!value) return;
	if (value === "direct" || value === "dm") return "direct";
	if (value === "group") return "group";
	if (value === "channel") return "channel";
}
//#endregion
//#region src/config/bindings.ts
function normalizeBindingType(binding) {
	return binding.type === "acp" ? "acp" : "route";
}
function isRouteBinding(binding) {
	return normalizeBindingType(binding) === "route";
}
function isAcpBinding(binding) {
	return normalizeBindingType(binding) === "acp";
}
function listConfiguredBindings(cfg) {
	return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}
function listRouteBindings(cfg) {
	return listConfiguredBindings(cfg).filter(isRouteBinding);
}
function listAcpBindings(cfg) {
	return listConfiguredBindings(cfg).filter(isAcpBinding);
}
//#endregion
//#region src/routing/bindings.ts
init_registry();
init_session_key();
function normalizeBindingChannelId(raw) {
	const normalized = normalizeChatChannelId(raw);
	if (normalized) return normalized;
	return (raw ?? "").trim().toLowerCase() || null;
}
function listBindings(cfg) {
	return listRouteBindings(cfg);
}
function resolveNormalizedBindingMatch(binding) {
	if (!binding || typeof binding !== "object") return null;
	const match = binding.match;
	if (!match || typeof match !== "object") return null;
	const channelId = normalizeBindingChannelId(match.channel);
	if (!channelId) return null;
	const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
	if (!accountId || accountId === "*") return null;
	return {
		agentId: normalizeAgentId(binding.agentId),
		accountId: normalizeAccountId(accountId),
		channelId
	};
}
function listBoundAccountIds(cfg, channelId) {
	const normalizedChannel = normalizeBindingChannelId(channelId);
	if (!normalizedChannel) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const binding of listBindings(cfg)) {
		const resolved = resolveNormalizedBindingMatch(binding);
		if (!resolved || resolved.channelId !== normalizedChannel) continue;
		ids.add(resolved.accountId);
	}
	return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}
function resolveDefaultAgentBoundAccountId(cfg, channelId) {
	const normalizedChannel = normalizeBindingChannelId(channelId);
	if (!normalizedChannel) return null;
	const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
	for (const binding of listBindings(cfg)) {
		const resolved = resolveNormalizedBindingMatch(binding);
		if (!resolved || resolved.channelId !== normalizedChannel || resolved.agentId !== defaultAgentId) continue;
		return resolved.accountId;
	}
	return null;
}
function buildChannelAccountBindings(cfg) {
	const map = /* @__PURE__ */ new Map();
	for (const binding of listBindings(cfg)) {
		const resolved = resolveNormalizedBindingMatch(binding);
		if (!resolved) continue;
		const byAgent = map.get(resolved.channelId) ?? /* @__PURE__ */ new Map();
		const list = byAgent.get(resolved.agentId) ?? [];
		if (!list.includes(resolved.accountId)) list.push(resolved.accountId);
		byAgent.set(resolved.agentId, list);
		map.set(resolved.channelId, byAgent);
	}
	return map;
}
//#endregion
//#region src/routing/resolve-route.ts
init_globals();
init_session_key();
function deriveLastRoutePolicy(params) {
	return params.sessionKey === params.mainSessionKey ? "main" : "session";
}
function resolveInboundLastRouteSessionKey(params) {
	return params.route.lastRoutePolicy === "main" ? params.route.mainSessionKey : params.sessionKey;
}
function normalizeToken(value) {
	return (value ?? "").trim().toLowerCase();
}
function normalizeId(value) {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "bigint") return String(value).trim();
	return "";
}
function buildAgentSessionKey(params) {
	const channel = normalizeToken(params.channel) || "unknown";
	const peer = params.peer;
	return buildAgentPeerSessionKey({
		agentId: params.agentId,
		mainKey: DEFAULT_MAIN_KEY,
		channel,
		accountId: params.accountId,
		peerKind: peer?.kind ?? "direct",
		peerId: peer ? normalizeId(peer.id) || "unknown" : null,
		dmScope: params.dmScope,
		identityLinks: params.identityLinks
	});
}
function listAgents(cfg) {
	const agents = cfg.agents?.list;
	return Array.isArray(agents) ? agents : [];
}
const agentLookupCacheByCfg = /* @__PURE__ */ new WeakMap();
function resolveAgentLookupCache(cfg) {
	const agentsRef = cfg.agents;
	const existing = agentLookupCacheByCfg.get(cfg);
	if (existing && existing.agentsRef === agentsRef) return existing;
	const byNormalizedId = /* @__PURE__ */ new Map();
	for (const agent of listAgents(cfg)) {
		const rawId = agent.id?.trim();
		if (!rawId) continue;
		byNormalizedId.set(normalizeAgentId(rawId), sanitizeAgentId(rawId));
	}
	const next = {
		agentsRef,
		byNormalizedId,
		fallbackDefaultAgentId: sanitizeAgentId(resolveDefaultAgentId(cfg))
	};
	agentLookupCacheByCfg.set(cfg, next);
	return next;
}
function pickFirstExistingAgentId(cfg, agentId) {
	const lookup = resolveAgentLookupCache(cfg);
	const trimmed = (agentId ?? "").trim();
	if (!trimmed) return lookup.fallbackDefaultAgentId;
	const normalized = normalizeAgentId(trimmed);
	if (lookup.byNormalizedId.size === 0) return sanitizeAgentId(trimmed);
	const resolved = lookup.byNormalizedId.get(normalized);
	if (resolved) return resolved;
	return lookup.fallbackDefaultAgentId;
}
const evaluatedBindingsCacheByCfg = /* @__PURE__ */ new WeakMap();
const MAX_EVALUATED_BINDINGS_CACHE_KEYS = 2e3;
const resolvedRouteCacheByCfg = /* @__PURE__ */ new WeakMap();
const MAX_RESOLVED_ROUTE_CACHE_KEYS = 4e3;
function resolveAccountPatternKey(accountPattern) {
	if (!accountPattern.trim()) return DEFAULT_ACCOUNT_ID;
	return normalizeAccountId(accountPattern);
}
function buildEvaluatedBindingsByChannel(cfg) {
	const byChannel = /* @__PURE__ */ new Map();
	let order = 0;
	for (const binding of listBindings(cfg)) {
		if (!binding || typeof binding !== "object") continue;
		const channel = normalizeToken(binding.match?.channel);
		if (!channel) continue;
		const match = normalizeBindingMatch(binding.match);
		const evaluated = {
			binding,
			match,
			order
		};
		order += 1;
		let bucket = byChannel.get(channel);
		if (!bucket) {
			bucket = {
				byAccount: /* @__PURE__ */ new Map(),
				byAnyAccount: []
			};
			byChannel.set(channel, bucket);
		}
		if (match.accountPattern === "*") {
			bucket.byAnyAccount.push(evaluated);
			continue;
		}
		const accountKey = resolveAccountPatternKey(match.accountPattern);
		const existing = bucket.byAccount.get(accountKey);
		if (existing) {
			existing.push(evaluated);
			continue;
		}
		bucket.byAccount.set(accountKey, [evaluated]);
	}
	return byChannel;
}
function mergeEvaluatedBindingsInSourceOrder(accountScoped, anyAccount) {
	if (accountScoped.length === 0) return anyAccount;
	if (anyAccount.length === 0) return accountScoped;
	const merged = [];
	let accountIdx = 0;
	let anyIdx = 0;
	while (accountIdx < accountScoped.length && anyIdx < anyAccount.length) {
		const accountBinding = accountScoped[accountIdx];
		const anyBinding = anyAccount[anyIdx];
		if ((accountBinding?.order ?? Number.MAX_SAFE_INTEGER) <= (anyBinding?.order ?? Number.MAX_SAFE_INTEGER)) {
			if (accountBinding) merged.push(accountBinding);
			accountIdx += 1;
			continue;
		}
		if (anyBinding) merged.push(anyBinding);
		anyIdx += 1;
	}
	if (accountIdx < accountScoped.length) merged.push(...accountScoped.slice(accountIdx));
	if (anyIdx < anyAccount.length) merged.push(...anyAccount.slice(anyIdx));
	return merged;
}
function pushToIndexMap(map, key, binding) {
	if (!key) return;
	const existing = map.get(key);
	if (existing) {
		existing.push(binding);
		return;
	}
	map.set(key, [binding]);
}
function peerLookupKeys(kind, id) {
	if (kind === "group") return [`group:${id}`, `channel:${id}`];
	if (kind === "channel") return [`channel:${id}`, `group:${id}`];
	return [`${kind}:${id}`];
}
function collectPeerIndexedBindings(index, peer) {
	if (!peer) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const key of peerLookupKeys(peer.kind, peer.id)) {
		const matches = index.byPeer.get(key);
		if (!matches) continue;
		for (const match of matches) {
			if (seen.has(match)) continue;
			seen.add(match);
			out.push(match);
		}
	}
	return out;
}
function buildEvaluatedBindingsIndex(bindings) {
	const byPeer = /* @__PURE__ */ new Map();
	const byGuildWithRoles = /* @__PURE__ */ new Map();
	const byGuild = /* @__PURE__ */ new Map();
	const byTeam = /* @__PURE__ */ new Map();
	const byAccount = [];
	const byChannel = [];
	for (const binding of bindings) {
		if (binding.match.peer.state === "valid") {
			for (const key of peerLookupKeys(binding.match.peer.kind, binding.match.peer.id)) pushToIndexMap(byPeer, key, binding);
			continue;
		}
		if (binding.match.guildId && binding.match.roles) {
			pushToIndexMap(byGuildWithRoles, binding.match.guildId, binding);
			continue;
		}
		if (binding.match.guildId && !binding.match.roles) {
			pushToIndexMap(byGuild, binding.match.guildId, binding);
			continue;
		}
		if (binding.match.teamId) {
			pushToIndexMap(byTeam, binding.match.teamId, binding);
			continue;
		}
		if (binding.match.accountPattern !== "*") {
			byAccount.push(binding);
			continue;
		}
		byChannel.push(binding);
	}
	return {
		byPeer,
		byGuildWithRoles,
		byGuild,
		byTeam,
		byAccount,
		byChannel
	};
}
function getEvaluatedBindingsForChannelAccount(cfg, channel, accountId) {
	const bindingsRef = cfg.bindings;
	const existing = evaluatedBindingsCacheByCfg.get(cfg);
	const cache = existing && existing.bindingsRef === bindingsRef ? existing : {
		bindingsRef,
		byChannel: buildEvaluatedBindingsByChannel(cfg),
		byChannelAccount: /* @__PURE__ */ new Map(),
		byChannelAccountIndex: /* @__PURE__ */ new Map()
	};
	if (cache !== existing) evaluatedBindingsCacheByCfg.set(cfg, cache);
	const cacheKey = `${channel}\t${accountId}`;
	const hit = cache.byChannelAccount.get(cacheKey);
	if (hit) return hit;
	const channelBindings = cache.byChannel.get(channel);
	const evaluated = mergeEvaluatedBindingsInSourceOrder(channelBindings?.byAccount.get(accountId) ?? [], channelBindings?.byAnyAccount ?? []);
	cache.byChannelAccount.set(cacheKey, evaluated);
	cache.byChannelAccountIndex.set(cacheKey, buildEvaluatedBindingsIndex(evaluated));
	if (cache.byChannelAccount.size > MAX_EVALUATED_BINDINGS_CACHE_KEYS) {
		cache.byChannelAccount.clear();
		cache.byChannelAccountIndex.clear();
		cache.byChannelAccount.set(cacheKey, evaluated);
		cache.byChannelAccountIndex.set(cacheKey, buildEvaluatedBindingsIndex(evaluated));
	}
	return evaluated;
}
function getEvaluatedBindingIndexForChannelAccount(cfg, channel, accountId) {
	const bindings = getEvaluatedBindingsForChannelAccount(cfg, channel, accountId);
	const existing = evaluatedBindingsCacheByCfg.get(cfg);
	const cacheKey = `${channel}\t${accountId}`;
	const indexed = existing?.byChannelAccountIndex.get(cacheKey);
	if (indexed) return indexed;
	const built = buildEvaluatedBindingsIndex(bindings);
	existing?.byChannelAccountIndex.set(cacheKey, built);
	return built;
}
function normalizePeerConstraint(peer) {
	if (!peer) return { state: "none" };
	const kind = normalizeChatType(peer.kind);
	const id = normalizeId(peer.id);
	if (!kind || !id) return { state: "invalid" };
	return {
		state: "valid",
		kind,
		id
	};
}
function normalizeBindingMatch(match) {
	const rawRoles = match?.roles;
	return {
		accountPattern: (match?.accountId ?? "").trim(),
		peer: normalizePeerConstraint(match?.peer),
		guildId: normalizeId(match?.guildId) || null,
		teamId: normalizeId(match?.teamId) || null,
		roles: Array.isArray(rawRoles) && rawRoles.length > 0 ? rawRoles : null
	};
}
function resolveRouteCacheForConfig(cfg) {
	const existing = resolvedRouteCacheByCfg.get(cfg);
	if (existing && existing.bindingsRef === cfg.bindings && existing.agentsRef === cfg.agents && existing.sessionRef === cfg.session) return existing.byKey;
	const byKey = /* @__PURE__ */ new Map();
	resolvedRouteCacheByCfg.set(cfg, {
		bindingsRef: cfg.bindings,
		agentsRef: cfg.agents,
		sessionRef: cfg.session,
		byKey
	});
	return byKey;
}
function formatRouteCachePeer(peer) {
	if (!peer || !peer.id) return "-";
	return `${peer.kind}:${peer.id}`;
}
function formatRoleIdsCacheKey(roleIds) {
	const count = roleIds.length;
	if (count === 0) return "-";
	if (count === 1) return roleIds[0] ?? "-";
	if (count === 2) {
		const first = roleIds[0] ?? "";
		const second = roleIds[1] ?? "";
		return first <= second ? `${first},${second}` : `${second},${first}`;
	}
	return roleIds.toSorted().join(",");
}
function buildResolvedRouteCacheKey(params) {
	return `${params.channel}\t${params.accountId}\t${formatRouteCachePeer(params.peer)}\t${formatRouteCachePeer(params.parentPeer)}\t${params.guildId || "-"}\t${params.teamId || "-"}\t${formatRoleIdsCacheKey(params.memberRoleIds)}\t${params.dmScope}`;
}
function hasGuildConstraint(match) {
	return Boolean(match.guildId);
}
function hasTeamConstraint(match) {
	return Boolean(match.teamId);
}
function hasRolesConstraint(match) {
	return Boolean(match.roles);
}
function peerKindMatches(bindingKind, scopeKind) {
	if (bindingKind === scopeKind) return true;
	const both = new Set([bindingKind, scopeKind]);
	return both.has("group") && both.has("channel");
}
function matchesBindingScope(match, scope) {
	if (match.peer.state === "invalid") return false;
	if (match.peer.state === "valid") {
		if (!scope.peer || !peerKindMatches(match.peer.kind, scope.peer.kind) || scope.peer.id !== match.peer.id) return false;
	}
	if (match.guildId && match.guildId !== scope.guildId) return false;
	if (match.teamId && match.teamId !== scope.teamId) return false;
	if (match.roles) {
		for (const role of match.roles) if (scope.memberRoleIds.has(role)) return true;
		return false;
	}
	return true;
}
function resolveAgentRoute(input) {
	const channel = normalizeToken(input.channel);
	const accountId = normalizeAccountId(input.accountId);
	const peer = input.peer ? {
		kind: normalizeChatType(input.peer.kind) ?? input.peer.kind,
		id: normalizeId(input.peer.id)
	} : null;
	const guildId = normalizeId(input.guildId);
	const teamId = normalizeId(input.teamId);
	const memberRoleIds = input.memberRoleIds ?? [];
	const memberRoleIdSet = new Set(memberRoleIds);
	const dmScope = input.cfg.session?.dmScope ?? "main";
	const identityLinks = input.cfg.session?.identityLinks;
	const shouldLogDebug = shouldLogVerbose();
	const parentPeer = input.parentPeer ? {
		kind: normalizeChatType(input.parentPeer.kind) ?? input.parentPeer.kind,
		id: normalizeId(input.parentPeer.id)
	} : null;
	const routeCache = !shouldLogDebug && !identityLinks ? resolveRouteCacheForConfig(input.cfg) : null;
	const routeCacheKey = routeCache ? buildResolvedRouteCacheKey({
		channel,
		accountId,
		peer,
		parentPeer,
		guildId,
		teamId,
		memberRoleIds,
		dmScope
	}) : "";
	if (routeCache && routeCacheKey) {
		const cachedRoute = routeCache.get(routeCacheKey);
		if (cachedRoute) return { ...cachedRoute };
	}
	const bindings = getEvaluatedBindingsForChannelAccount(input.cfg, channel, accountId);
	const bindingsIndex = getEvaluatedBindingIndexForChannelAccount(input.cfg, channel, accountId);
	const choose = (agentId, matchedBy) => {
		const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
		const sessionKey = buildAgentSessionKey({
			agentId: resolvedAgentId,
			channel,
			accountId,
			peer,
			dmScope,
			identityLinks
		}).toLowerCase();
		const mainSessionKey = buildAgentMainSessionKey({
			agentId: resolvedAgentId,
			mainKey: DEFAULT_MAIN_KEY
		}).toLowerCase();
		const route = {
			agentId: resolvedAgentId,
			channel,
			accountId,
			sessionKey,
			mainSessionKey,
			lastRoutePolicy: deriveLastRoutePolicy({
				sessionKey,
				mainSessionKey
			}),
			matchedBy
		};
		if (routeCache && routeCacheKey) {
			routeCache.set(routeCacheKey, route);
			if (routeCache.size > MAX_RESOLVED_ROUTE_CACHE_KEYS) {
				routeCache.clear();
				routeCache.set(routeCacheKey, route);
			}
		}
		return route;
	};
	const formatPeer = (value) => value?.kind && value?.id ? `${value.kind}:${value.id}` : "none";
	const formatNormalizedPeer = (value) => {
		if (value.state === "none") return "none";
		if (value.state === "invalid") return "invalid";
		return `${value.kind}:${value.id}`;
	};
	if (shouldLogDebug) {
		logDebug(`[routing] resolveAgentRoute: channel=${channel} accountId=${accountId} peer=${formatPeer(peer)} guildId=${guildId || "none"} teamId=${teamId || "none"} bindings=${bindings.length}`);
		for (const entry of bindings) logDebug(`[routing] binding: agentId=${entry.binding.agentId} accountPattern=${entry.match.accountPattern || "default"} peer=${formatNormalizedPeer(entry.match.peer)} guildId=${entry.match.guildId ?? "none"} teamId=${entry.match.teamId ?? "none"} roles=${entry.match.roles?.length ?? 0}`);
	}
	const baseScope = {
		guildId,
		teamId,
		memberRoleIds: memberRoleIdSet
	};
	const tiers = [
		{
			matchedBy: "binding.peer",
			enabled: Boolean(peer),
			scopePeer: peer,
			candidates: collectPeerIndexedBindings(bindingsIndex, peer),
			predicate: (candidate) => candidate.match.peer.state === "valid"
		},
		{
			matchedBy: "binding.peer.parent",
			enabled: Boolean(parentPeer && parentPeer.id),
			scopePeer: parentPeer && parentPeer.id ? parentPeer : null,
			candidates: collectPeerIndexedBindings(bindingsIndex, parentPeer),
			predicate: (candidate) => candidate.match.peer.state === "valid"
		},
		{
			matchedBy: "binding.guild+roles",
			enabled: Boolean(guildId && memberRoleIds.length > 0),
			scopePeer: peer,
			candidates: guildId ? bindingsIndex.byGuildWithRoles.get(guildId) ?? [] : [],
			predicate: (candidate) => hasGuildConstraint(candidate.match) && hasRolesConstraint(candidate.match)
		},
		{
			matchedBy: "binding.guild",
			enabled: Boolean(guildId),
			scopePeer: peer,
			candidates: guildId ? bindingsIndex.byGuild.get(guildId) ?? [] : [],
			predicate: (candidate) => hasGuildConstraint(candidate.match) && !hasRolesConstraint(candidate.match)
		},
		{
			matchedBy: "binding.team",
			enabled: Boolean(teamId),
			scopePeer: peer,
			candidates: teamId ? bindingsIndex.byTeam.get(teamId) ?? [] : [],
			predicate: (candidate) => hasTeamConstraint(candidate.match)
		},
		{
			matchedBy: "binding.account",
			enabled: true,
			scopePeer: peer,
			candidates: bindingsIndex.byAccount,
			predicate: (candidate) => candidate.match.accountPattern !== "*"
		},
		{
			matchedBy: "binding.channel",
			enabled: true,
			scopePeer: peer,
			candidates: bindingsIndex.byChannel,
			predicate: (candidate) => candidate.match.accountPattern === "*"
		}
	];
	for (const tier of tiers) {
		if (!tier.enabled) continue;
		const matched = tier.candidates.find((candidate) => tier.predicate(candidate) && matchesBindingScope(candidate.match, {
			...baseScope,
			peer: tier.scopePeer
		}));
		if (matched) {
			if (shouldLogDebug) logDebug(`[routing] match: matchedBy=${tier.matchedBy} agentId=${matched.binding.agentId}`);
			return choose(matched.binding.agentId, tier.matchedBy);
		}
	}
	return choose(resolveDefaultAgentId(input.cfg), "default");
}
//#endregion
export { resolvePluginConversationBindingApproval as $, BlockStreamingChunkSchema as $n, warnMissingProviderGroupPolicyFallbackOnce as $t, createDedupeCache as A, ensureTargetId as An, sensitive as Ar, resolveDiscordGuildEntry as At, getPluginCommandSpecs as B, defaultSlotIdForKey as Bn, secretRefKey as Br, resolveDiscordSystemLocation as Bt, requireActivePluginHttpRouteRegistry as C, createAccountListHelpers as Cn, ToolsLinksSchema as Cr, listDiscordDirectoryPeersLive as Ct, clearPluginInteractiveHandlers as D, init_directory_cache as Dn, TypingModeSchema as Dr, normalizeDiscordSlug as Dt, init_registry$1 as E, init_account_action_gate as En, TtsConfigSchema as Er, normalizeDiscordAllowList as Et, init_http_route_overlap as F, init_internal_hooks as Fn, SINGLE_VALUE_FILE_REF_ID as Fr, resolveGroupDmAllow as Ft, buildPluginBindingErrorText as G, parseOptionalDelimitedEntries as Gn, moveSingleAccountChannelSectionToDefaultAccount as Gr, evaluateSenderGroupAccessForPolicy as Gt, listPluginCommands as H, PAIRING_APPROVED_MESSAGE as Hn, applyAccountNameToChannelSection as Hr, evaluateGroupRouteAccessForPolicy as Ht, init_http_path as I, triggerInternalHook as In, formatExecSecretRefIdValidationMessage as Ir, shouldEmitDiscordReactionNotification as It, hasShownPluginBindingFallbackNotice as J, setAccountEnabledInConfigSection as Jn, GROUP_POLICY_BLOCKED_LABEL as Jt, buildPluginBindingResolvedText as K, clearAccountEntryFields as Kn, patchScopedAccountConfig as Kr, init_group_access as Kt, normalizePluginHttpPath as L, init_registry$3 as Ln, isValidExecSecretRefId as Lr, formatDiscordReactionEmoji as Lt, init_map_size as M, parseMentionPrefixOrAtUserTarget as Mn, EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN as Mr, resolveDiscordOwnerAccess as Mt, pruneMapToMaxSize as N, requireTargetKind as Nn, FILE_SECRET_REF_ID_PATTERN as Nr, resolveDiscordOwnerAllowFrom as Nt, dispatchPluginInteractiveHandler as O, resolveDiscordDirectoryUserId as On, requireAllowlistAllowFrom as Or, resolveDiscordAllowListMatch as Ot, findOverlappingPluginHttpRoute as P, createInternalHookEvent as Pn, SECRET_PROVIDER_ALIAS_PATTERN$1 as Pr, resolveDiscordShouldRequireMention as Pt, parsePluginBindingApprovalCustomId as Q, buildNestedDmConfigSchema as Qn, resolveOpenProviderRuntimeGroupPolicy as Qt, clearPluginCommands as R, registerContextEngineForOwner as Rn, isValidFileSecretRefId as Rr, formatDiscordUserTag as Rt, init_runtime as S, resolveAccountEntry as Sn, SecretsConfigSchema as Sr, listDiscordDirectoryGroupsLive as St, createPluginRegistry as T, createAccountActionGate as Tn, TranscribeAudioSchema as Tr, isDiscordGroupAllowedByPolicy as Tt, matchPluginCommand as U, buildAccountScopedDmSecurityPolicy as Un, applySetupAccountConfigPatch as Ur, evaluateMatchedGroupAccessForPolicy as Ut, init_commands as V, init_slots as Vn, isSafeExecutableValue as Vr, resolveTimestampMs as Vt, buildPluginBindingDeclinedText as W, formatPairingApproveHint as Wn, migrateBaseNameToDefaultAccount as Wr, evaluateSenderGroupAccess as Wt, isPluginOwnedSessionBindingRecord as X, buildCatchallMultiAccountChannelSchema as Xn, resolveAllowlistProviderRuntimeGroupPolicy as Xt, init_conversation_binding as Y, AllowFromListSchema as Yn, init_runtime_group_policy as Yt, markPluginBindingFallbackNoticeShown as Z, buildChannelConfigSchema as Zn, resolveDefaultGroupPolicy as Zt, normalizeChatChannelId as _, resolveDiscordAccountConfig as _n, ReplyRuntimeConfigSchemaShape as _r, init_targets$1 as _t, resolveInboundLastRouteSessionKey as a, resolveChannelEntryMatchWithFallback as an, GroupChatSchema as ar, unregisterSessionBindingAdapter as at, getActivePluginRegistryKey as b, normalizeDiscordToken as bn, SecretInputSchema as br, resolveDiscordTarget as bt, resolveDefaultAgentBoundAccountId as c, fetchDiscord as cn, HumanDelaySchema as cr, getChannelPlugin as ct, tryReadSecretFileSync as d, init_accounts as dn, MSTeamsReplyStyleSchema as dr, normalizeChannelId$1 as dt, applyChannelMatchMeta as en, BlockStreamingCoalesceSchema as er, toPluginConversationBinding as et, getChatChannelMeta as f, listDiscordAccountIds as fn, MarkdownConfigSchema as fr, init_targets as ft, normalizeChannelId as g, resolveDiscordAccount as gn, QueueSchema as gr, resolveTelegramTargetChatType as gt, normalizeAnyChannelId as h, resolveDefaultDiscordAccountId as hn, ProviderCommandsSchema as hr, parseTelegramTarget as ht, resolveAgentRoute as i, resolveChannelEntryMatch as in, ExecutableTokenSchema as ir, registerSessionBindingAdapter as it, init_dedupe as j, init_targets$2 as jn, createAllowDenyChannelRulesSchema as jr, resolveDiscordMemberAccessState as jt, init_interactive as k, buildMessagingTarget as kn, requireOpenAllowFrom as kr, resolveDiscordChannelConfigWithFallback as kt, listAcpBindings as l, init_api as ln, IdentitySchema as lr, init_registry$2 as lt, listChatChannels as m, mergeDiscordAccountConfig as mn, NativeCommandsSettingSchema as mr, normalizeTelegramLookupTarget as mt, deriveLastRoutePolicy as n, init_channel_config as nn, DmConfigSchema as nr, init_session_binding_service as nt, buildChannelAccountBindings as o, resolveNestedAllowlistDecision as on, GroupPolicySchema as or, init_target_parsing as ot, init_registry as p, listEnabledDiscordAccounts as pn, ModelsConfigSchema as pr, normalizeTelegramChatId as pt, buildPluginBindingUnavailableText as q, deleteAccountFromConfigSection as qn, resolveSenderScopedGroupPolicy as qt, pickFirstExistingAgentId as r, normalizeChannelSlug as rn, DmPolicySchema as rr, isSessionBindingError as rt, listBoundAccountIds as s, DiscordApiError as sn, HexColorSchema as sr, parseExplicitTargetForChannel as st, buildAgentSessionKey as t, buildChannelKeyCandidates as tn, CliBackendSchema as tr, getSessionBindingService as tt, normalizeChatType as u, createDiscordActionGate as un, InboundDebounceSchema as ur, listChannelPlugins as ut, registry_exports as v, resolveDiscordMaxLinesPerMessage as vn, ReplyToModeSchema as vr, parseDiscordTarget as vt, setActivePluginRegistry as w, init_account_helpers as wn, ToolsMediaSchema as wr, init_allow_list as wt, getActivePluginRegistryVersion as x, init_account_lookup as xn, SecretRefSchema as xr, init_directory_live as xt, getActivePluginRegistry as y, init_token as yn, RetryConfigSchema as yr, resolveDiscordChannelId as yt, executePluginCommand as z, resolveContextEngine as zn, resolveDefaultSecretProviderAlias as zr, init_format as zt };
