import { z } from "zod";
import path from "node:path";
import chalk, { Chalk } from "chalk";
import fs from "node:fs";
import { Logger } from "tslog";
import os from "node:os";
import json5 from "json5";
//#region src/routing/account-id.ts
const DEFAULT_ACCOUNT_ID = "default";
//#endregion
//#region src/channels/plugins/config-helpers.ts
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
const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
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
z.object({
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
z.object({
	mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
	providers: z.record(z.string(), ModelProviderSchema).optional(),
	bedrockDiscovery: BedrockDiscoverySchema
}).strict().optional();
z.object({
	mentionPatterns: z.array(z.string()).optional(),
	historyLimit: z.number().int().positive().optional()
}).strict().optional();
const DmConfigSchema = z.object({ historyLimit: z.number().int().min(0).optional() }).strict();
z.object({
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
z.union([
	z.literal("off"),
	z.literal("first"),
	z.literal("all")
]);
z.union([
	z.literal("never"),
	z.literal("instant"),
	z.literal("thinking"),
	z.literal("message")
]);
z.enum([
	"open",
	"disabled",
	"allowlist"
]);
z.enum([
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
z.number().int().min(0).optional(), z.number().int().min(0).optional(), z.record(z.string(), DmConfigSchema.optional()).optional(), z.number().int().positive().optional(), z.enum(["length", "newline"]).optional(), z.boolean().optional(), BlockStreamingCoalesceSchema.optional(), z.string().optional(), z.number().positive().optional();
z.object({
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
z.object({ tables: MarkdownTableModeSchema.optional() }).strict().optional();
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
z.object({
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
z.object({
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
z.object({
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
z.enum(["thread", "top-level"]);
z.object({
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
z.object({
	mode: QueueModeSchema.optional(),
	byChannel: QueueModeBySurfaceSchema,
	debounceMs: z.number().int().nonnegative().optional(),
	debounceMsByChannel: DebounceMsBySurfaceSchema,
	cap: z.number().int().positive().optional(),
	drop: QueueDropSchema.optional()
}).strict().optional();
z.object({
	debounceMs: z.number().int().nonnegative().optional(),
	byChannel: DebounceMsBySurfaceSchema
}).strict().optional();
z.object({
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
z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");
z.string().refine(isSafeExecutableValue, "expected safe executable name or path");
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
z.object({
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
z.object({
	enabled: z.boolean().optional(),
	scope: MediaUnderstandingScopeSchema,
	maxLinks: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	models: z.array(LinkModelSchema).optional()
}).strict().optional();
const NativeCommandsSettingSchema = z.union([z.boolean(), z.literal("auto")]);
z.object({
	native: NativeCommandsSettingSchema.optional(),
	nativeSkills: NativeCommandsSettingSchema.optional()
}).strict().optional();
//#endregion
//#region src/channels/plugins/config-schema.ts
const AllowFromEntrySchema = z.union([z.string(), z.number()]);
z.array(AllowFromEntrySchema).optional();
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
const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 3e4;
const DEFAULT_ERROR_MESSAGE = {
	PAYLOAD_TOO_LARGE: "PayloadTooLarge",
	REQUEST_BODY_TIMEOUT: "RequestBodyTimeout",
	CONNECTION_CLOSED: "RequestBodyConnectionClosed"
};
const DEFAULT_ERROR_STATUS_CODE = {
	PAYLOAD_TOO_LARGE: 413,
	REQUEST_BODY_TIMEOUT: 408,
	CONNECTION_CLOSED: 400
};
const DEFAULT_RESPONSE_MESSAGE = {
	PAYLOAD_TOO_LARGE: "Payload too large",
	REQUEST_BODY_TIMEOUT: "Request body timeout",
	CONNECTION_CLOSED: "Connection closed"
};
var RequestBodyLimitError = class extends Error {
	constructor(init) {
		super(init.message ?? DEFAULT_ERROR_MESSAGE[init.code]);
		this.name = "RequestBodyLimitError";
		this.code = init.code;
		this.statusCode = DEFAULT_ERROR_STATUS_CODE[init.code];
	}
};
function isRequestBodyLimitError(error, code) {
	if (!(error instanceof RequestBodyLimitError)) return false;
	if (!code) return true;
	return error.code === code;
}
function requestBodyErrorToText(code) {
	return DEFAULT_RESPONSE_MESSAGE[code];
}
function parseContentLengthHeader(req) {
	const header = req.headers["content-length"];
	const raw = Array.isArray(header) ? header[0] : header;
	if (typeof raw !== "string") return null;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return parsed;
}
function resolveRequestBodyLimitValues(options) {
	return {
		maxBytes: Number.isFinite(options.maxBytes) ? Math.max(1, Math.floor(options.maxBytes)) : 1,
		timeoutMs: typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs)) : DEFAULT_WEBHOOK_BODY_TIMEOUT_MS
	};
}
async function readRequestBodyWithLimit(req, options) {
	const { maxBytes, timeoutMs } = resolveRequestBodyLimitValues(options);
	const encoding = options.encoding ?? "utf-8";
	const declaredLength = parseContentLengthHeader(req);
	if (declaredLength !== null && declaredLength > maxBytes) {
		const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
		if (!req.destroyed) req.destroy();
		throw error;
	}
	return await new Promise((resolve, reject) => {
		let done = false;
		let ended = false;
		let totalBytes = 0;
		const chunks = [];
		const cleanup = () => {
			req.removeListener("data", onData);
			req.removeListener("end", onEnd);
			req.removeListener("error", onError);
			req.removeListener("close", onClose);
			clearTimeout(timer);
		};
		const finish = (cb) => {
			if (done) return;
			done = true;
			cleanup();
			cb();
		};
		const fail = (error) => {
			finish(() => reject(error));
		};
		const timer = setTimeout(() => {
			const error = new RequestBodyLimitError({ code: "REQUEST_BODY_TIMEOUT" });
			if (!req.destroyed) req.destroy();
			fail(error);
		}, timeoutMs);
		const onData = (chunk) => {
			if (done) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			totalBytes += buffer.length;
			if (totalBytes > maxBytes) {
				const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
				if (!req.destroyed) req.destroy();
				fail(error);
				return;
			}
			chunks.push(buffer);
		};
		const onEnd = () => {
			ended = true;
			finish(() => resolve(Buffer.concat(chunks).toString(encoding)));
		};
		const onError = (error) => {
			if (done) return;
			fail(error);
		};
		const onClose = () => {
			if (done || ended) return;
			fail(new RequestBodyLimitError({ code: "CONNECTION_CLOSED" }));
		};
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("close", onClose);
	});
}
//#endregion
//#region src/plugins/config-schema.ts
function error(message) {
	return {
		success: false,
		error: { issues: [{
			path: [],
			message
		}] }
	};
}
function emptyPluginConfigSchema() {
	return {
		safeParse(value) {
			if (value === void 0) return {
				success: true,
				data: void 0
			};
			if (!value || typeof value !== "object" || Array.isArray(value)) return error("expected config object");
			if (Object.keys(value).length > 0) return error("config must be empty");
			return {
				success: true,
				data: value
			};
		},
		jsonSchema: {
			type: "object",
			additionalProperties: false,
			properties: {}
		}
	};
}
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
//#endregion
//#region src/gateway/security-path.ts
const MAX_PATH_DECODE_PASSES = 32;
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
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level"]);
function isValueToken(arg) {
	if (!arg || arg === "--") return false;
	if (!arg.startsWith("-")) return true;
	return /^-\d+(?:\.\d+)?$/.test(arg);
}
function consumeRootOptionToken(args, index) {
	const arg = args[index];
	if (!arg) return 0;
	if (ROOT_BOOLEAN_FLAGS.has(arg)) return 1;
	if (arg.startsWith("--profile=") || arg.startsWith("--log-level=")) return 1;
	if (ROOT_VALUE_FLAGS.has(arg)) return isValueToken(args[index + 1]) ? 2 : 1;
	return 0;
}
//#endregion
//#region src/cli/argv.ts
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
//#endregion
//#region src/infra/tmp-openclaw-dir.ts
const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";
const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;
function isNodeErrorWithCode(err, code) {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function resolvePreferredOpenClawTmpDir(options = {}) {
	const accessSync = options.accessSync ?? fs.accessSync;
	const chmodSync = options.chmodSync ?? fs.chmodSync;
	const lstatSync = options.lstatSync ?? fs.lstatSync;
	const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
	const warn = options.warn ?? ((message) => console.warn(message));
	const getuid = options.getuid ?? (() => {
		try {
			return typeof process.getuid === "function" ? process.getuid() : void 0;
		} catch {
			return;
		}
	});
	const tmpdir = options.tmpdir ?? os.tmpdir;
	const uid = getuid();
	const isSecureDirForUser = (st) => {
		if (uid === void 0) return true;
		if (typeof st.uid === "number" && st.uid !== uid) return false;
		if (typeof st.mode === "number" && (st.mode & 18) !== 0) return false;
		return true;
	};
	const fallback = () => {
		const base = tmpdir();
		const suffix = uid === void 0 ? "openclaw" : `openclaw-${uid}`;
		return path.join(base, suffix);
	};
	const isTrustedTmpDir = (st) => {
		return st.isDirectory() && !st.isSymbolicLink() && isSecureDirForUser(st);
	};
	const resolveDirState = (candidatePath) => {
		try {
			if (!isTrustedTmpDir(lstatSync(candidatePath))) return "invalid";
			accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
			return "available";
		} catch (err) {
			if (isNodeErrorWithCode(err, "ENOENT")) return "missing";
			return "invalid";
		}
	};
	const tryRepairWritableBits = (candidatePath) => {
		try {
			const st = lstatSync(candidatePath);
			if (!st.isDirectory() || st.isSymbolicLink()) return false;
			if (uid !== void 0 && typeof st.uid === "number" && st.uid !== uid) return false;
			if (typeof st.mode !== "number" || (st.mode & 18) === 0) return false;
			chmodSync(candidatePath, 448);
			warn(`[openclaw] tightened permissions on temp dir: ${candidatePath}`);
			return resolveDirState(candidatePath) === "available";
		} catch {
			return false;
		}
	};
	const ensureTrustedFallbackDir = () => {
		const fallbackPath = fallback();
		const state = resolveDirState(fallbackPath);
		if (state === "available") return fallbackPath;
		if (state === "invalid") {
			if (tryRepairWritableBits(fallbackPath)) return fallbackPath;
			throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
		}
		try {
			mkdirSync(fallbackPath, {
				recursive: true,
				mode: 448
			});
			chmodSync(fallbackPath, 448);
		} catch {
			throw new Error(`Unable to create fallback OpenClaw temp dir: ${fallbackPath}`);
		}
		if (resolveDirState(fallbackPath) !== "available" && !tryRepairWritableBits(fallbackPath)) throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
		return fallbackPath;
	};
	const existingPreferredState = resolveDirState(POSIX_OPENCLAW_TMP_DIR);
	if (existingPreferredState === "available") return POSIX_OPENCLAW_TMP_DIR;
	if (existingPreferredState === "invalid") {
		if (tryRepairWritableBits("/tmp/openclaw")) return POSIX_OPENCLAW_TMP_DIR;
		return ensureTrustedFallbackDir();
	}
	try {
		accessSync("/tmp", TMP_DIR_ACCESS_MODE);
		mkdirSync(POSIX_OPENCLAW_TMP_DIR, {
			recursive: true,
			mode: 448
		});
		chmodSync(POSIX_OPENCLAW_TMP_DIR, 448);
		if (resolveDirState("/tmp/openclaw") !== "available" && !tryRepairWritableBits("/tmp/openclaw")) return ensureTrustedFallbackDir();
		return POSIX_OPENCLAW_TMP_DIR;
	} catch {
		return ensureTrustedFallbackDir();
	}
}
//#endregion
//#region src/infra/home-dir.ts
function normalize(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function resolveEffectiveHomeDir(env = process.env, homedir = os.homedir) {
	const raw = resolveRawHomeDir(env, homedir);
	return raw ? path.resolve(raw) : void 0;
}
function resolveRawHomeDir(env, homedir) {
	const explicitHome = normalize(env.OPENCLAW_HOME);
	if (explicitHome) {
		if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
			const fallbackHome = normalize(env.HOME) ?? normalize(env.USERPROFILE) ?? normalizeSafe(homedir);
			if (fallbackHome) return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
			return;
		}
		return explicitHome;
	}
	const envHome = normalize(env.HOME);
	if (envHome) return envHome;
	const userProfile = normalize(env.USERPROFILE);
	if (userProfile) return userProfile;
	return normalizeSafe(homedir);
}
function normalizeSafe(homedir) {
	try {
		return normalize(homedir());
	} catch {
		return;
	}
}
function resolveRequiredHomeDir(env = process.env, homedir = os.homedir) {
	return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
function expandHomePrefix(input, opts) {
	if (!input.startsWith("~")) return input;
	const home = normalize(opts?.home) ?? resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
	if (!home) return input;
	return input.replace(/^~(?=$|[\\/])/, home);
}
//#endregion
//#region src/config/paths.ts
/**
* Nix mode detection: When OPENCLAW_NIX_MODE=1, the gateway is running under Nix.
* In this mode:
* - No auto-install flows should be attempted
* - Missing dependencies should produce actionable Nix-specific error messages
* - Config is managed externally (read-only from Nix perspective)
*/
function resolveIsNixMode(env = process.env) {
	return env.OPENCLAW_NIX_MODE === "1";
}
resolveIsNixMode();
const LEGACY_STATE_DIRNAMES = [
	".clawdbot",
	".moldbot",
	".moltbot"
];
const NEW_STATE_DIRNAME = ".openclaw";
const CONFIG_FILENAME = "openclaw.json";
const LEGACY_CONFIG_FILENAMES = [
	"clawdbot.json",
	"moldbot.json",
	"moltbot.json"
];
function resolveDefaultHomeDir() {
	return resolveRequiredHomeDir(process.env, os.homedir);
}
/** Build a homedir thunk that respects OPENCLAW_HOME for the given env. */
function envHomedir(env) {
	return () => resolveRequiredHomeDir(env, os.homedir);
}
function legacyStateDirs(homedir = resolveDefaultHomeDir) {
	return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}
function newStateDir(homedir = resolveDefaultHomeDir) {
	return path.join(homedir(), NEW_STATE_DIRNAME);
}
/**
* State directory for mutable data (sessions, logs, caches).
* Can be overridden via OPENCLAW_STATE_DIR.
* Default: ~/.openclaw
*/
function resolveStateDir(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (override) return resolveUserPath$1(override, env, effectiveHomedir);
	const newDir = newStateDir(effectiveHomedir);
	if (env.OPENCLAW_TEST_FAST === "1") return newDir;
	const legacyDirs = legacyStateDirs(effectiveHomedir);
	if (fs.existsSync(newDir)) return newDir;
	const existingLegacy = legacyDirs.find((dir) => {
		try {
			return fs.existsSync(dir);
		} catch {
			return false;
		}
	});
	if (existingLegacy) return existingLegacy;
	return newDir;
}
function resolveUserPath$1(input, env = process.env, homedir = envHomedir(env)) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = expandHomePrefix(trimmed, {
			home: resolveRequiredHomeDir(env, homedir),
			env,
			homedir
		});
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
resolveStateDir();
/**
* Config file path (JSON5).
* Can be overridden via OPENCLAW_CONFIG_PATH.
* Default: ~/.openclaw/openclaw.json (or $OPENCLAW_STATE_DIR/openclaw.json)
*/
function resolveCanonicalConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env))) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
	if (override) return resolveUserPath$1(override, env, envHomedir(env));
	return path.join(stateDir, CONFIG_FILENAME);
}
/**
* Resolve the active config path by preferring existing config candidates
* before falling back to the canonical path.
*/
function resolveConfigPathCandidate(env = process.env, homedir = envHomedir(env)) {
	if (env.OPENCLAW_TEST_FAST === "1") return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
	const existing = resolveDefaultConfigCandidates(env, homedir).find((candidate) => {
		try {
			return fs.existsSync(candidate);
		} catch {
			return false;
		}
	});
	if (existing) return existing;
	return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
}
/**
* Active config path (prefers existing config files).
*/
function resolveConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env)), homedir = envHomedir(env)) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim();
	if (override) return resolveUserPath$1(override, env, homedir);
	if (env.OPENCLAW_TEST_FAST === "1") return path.join(stateDir, CONFIG_FILENAME);
	const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
	const existing = [path.join(stateDir, CONFIG_FILENAME), ...LEGACY_CONFIG_FILENAMES.map((name) => path.join(stateDir, name))].find((candidate) => {
		try {
			return fs.existsSync(candidate);
		} catch {
			return false;
		}
	});
	if (existing) return existing;
	if (stateOverride) return path.join(stateDir, CONFIG_FILENAME);
	const defaultStateDir = resolveStateDir(env, homedir);
	if (path.resolve(stateDir) === path.resolve(defaultStateDir)) return resolveConfigPathCandidate(env, homedir);
	return path.join(stateDir, CONFIG_FILENAME);
}
resolveConfigPathCandidate();
/**
* Resolve default config path candidates across default locations.
* Order: explicit config path → state-dir-derived paths → new default.
*/
function resolveDefaultConfigCandidates(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const explicit = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
	if (explicit) return [resolveUserPath$1(explicit, env, effectiveHomedir)];
	const candidates = [];
	const openclawStateDir = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (openclawStateDir) {
		const resolved = resolveUserPath$1(openclawStateDir, env, effectiveHomedir);
		candidates.push(path.join(resolved, CONFIG_FILENAME));
		candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(resolved, name)));
	}
	const defaultDirs = [newStateDir(effectiveHomedir), ...legacyStateDirs(effectiveHomedir)];
	for (const dir of defaultDirs) {
		candidates.push(path.join(dir, CONFIG_FILENAME));
		candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(dir, name)));
	}
	return candidates;
}
//#endregion
//#region src/logging/config.ts
function readLoggingConfig() {
	const configPath = resolveConfigPath();
	try {
		if (!fs.existsSync(configPath)) return;
		const raw = fs.readFileSync(configPath, "utf-8");
		const logging = json5.parse(raw)?.logging;
		if (!logging || typeof logging !== "object" || Array.isArray(logging)) return;
		return logging;
	} catch {
		return;
	}
}
//#endregion
//#region src/logging/levels.ts
const ALLOWED_LOG_LEVELS = [
	"silent",
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace"
];
function tryParseLogLevel(level) {
	if (typeof level !== "string") return;
	const candidate = level.trim();
	return ALLOWED_LOG_LEVELS.includes(candidate) ? candidate : void 0;
}
function normalizeLogLevel(level, fallback = "info") {
	return tryParseLogLevel(level) ?? fallback;
}
function levelToMinLevel(level) {
	return {
		fatal: 0,
		error: 1,
		warn: 2,
		info: 3,
		debug: 4,
		trace: 5,
		silent: Number.POSITIVE_INFINITY
	}[level];
}
//#endregion
//#region src/logging/state.ts
const loggingState = {
	cachedLogger: null,
	cachedSettings: null,
	cachedConsoleSettings: null,
	overrideSettings: null,
	invalidEnvLogLevelValue: null,
	consolePatched: false,
	forceConsoleToStderr: false,
	consoleTimestampPrefix: false,
	consoleSubsystemFilter: null,
	resolvingConsoleSettings: false,
	streamErrorHandlersInstalled: false,
	rawConsole: null
};
//#endregion
//#region src/logging/env-log-level.ts
function resolveEnvLogLevelOverride() {
	const raw = process.env.OPENCLAW_LOG_LEVEL;
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (!trimmed) {
		loggingState.invalidEnvLogLevelValue = null;
		return;
	}
	const parsed = tryParseLogLevel(trimmed);
	if (parsed) {
		loggingState.invalidEnvLogLevelValue = null;
		return parsed;
	}
	if (loggingState.invalidEnvLogLevelValue !== trimmed) {
		loggingState.invalidEnvLogLevelValue = trimmed;
		process.stderr.write(`[openclaw] Ignoring invalid OPENCLAW_LOG_LEVEL="${trimmed}" (allowed: ${ALLOWED_LOG_LEVELS.join("|")}).\n`);
	}
}
//#endregion
//#region src/logging/node-require.ts
function resolveNodeRequireFromMeta(metaUrl) {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return null;
	try {
		const moduleNamespace = getBuiltinModule("module");
		const createRequire = typeof moduleNamespace.createRequire === "function" ? moduleNamespace.createRequire : null;
		return createRequire ? createRequire(metaUrl) : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/logging/timestamps.ts
function isValidTimeZone(tz) {
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}
function formatLocalIsoWithOffset(now, timeZone) {
	const explicit = timeZone ?? process.env.TZ;
	const tz = explicit && isValidTimeZone(explicit) ? explicit : Intl.DateTimeFormat().resolvedOptions().timeZone;
	const fmt = new Intl.DateTimeFormat("en", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		fractionalSecondDigits: 3,
		timeZoneName: "longOffset"
	});
	const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
	const offsetRaw = parts.timeZoneName ?? "GMT";
	const offset = offsetRaw === "GMT" ? "+00:00" : offsetRaw.slice(3);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
}
//#endregion
//#region src/logging/logger.ts
const DEFAULT_LOG_DIR = resolvePreferredOpenClawTmpDir();
path.join(DEFAULT_LOG_DIR, "openclaw.log");
const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 1440 * 60 * 1e3;
const DEFAULT_MAX_LOG_FILE_BYTES = 500 * 1024 * 1024;
const requireConfig$1 = resolveNodeRequireFromMeta(import.meta.url);
const externalTransports = /* @__PURE__ */ new Set();
function shouldSkipLoadConfigFallback(argv = process.argv) {
	const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
	return primary === "config" && secondary === "validate";
}
function attachExternalTransport(logger, transport) {
	logger.attachTransport((logObj) => {
		if (!externalTransports.has(transport)) return;
		try {
			transport(logObj);
		} catch {}
	});
}
function canUseSilentVitestFileLogFastPath(envLevel) {
	return process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" && !envLevel && !loggingState.overrideSettings;
}
function resolveSettings() {
	const envLevel = resolveEnvLogLevelOverride();
	if (canUseSilentVitestFileLogFastPath(envLevel)) return {
		level: "silent",
		file: defaultRollingPathForToday(),
		maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES
	};
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg && !shouldSkipLoadConfigFallback()) try {
		cfg = (requireConfig$1?.("../config/config.js"))?.loadConfig?.().logging;
	} catch {
		cfg = void 0;
	}
	const defaultLevel = process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" ? "silent" : "info";
	const fromConfig = normalizeLogLevel(cfg?.level, defaultLevel);
	return {
		level: envLevel ?? fromConfig,
		file: cfg?.file ?? defaultRollingPathForToday(),
		maxFileBytes: resolveMaxLogFileBytes(cfg?.maxFileBytes)
	};
}
function settingsChanged(a, b) {
	if (!a) return true;
	return a.level !== b.level || a.file !== b.file || a.maxFileBytes !== b.maxFileBytes;
}
function isFileLogLevelEnabled(level) {
	const settings = loggingState.cachedSettings ?? resolveSettings();
	if (!loggingState.cachedSettings) loggingState.cachedSettings = settings;
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
function buildLogger(settings) {
	const logger = new Logger({
		name: "openclaw",
		minLevel: levelToMinLevel(settings.level),
		type: "hidden"
	});
	if (settings.level === "silent") {
		for (const transport of externalTransports) attachExternalTransport(logger, transport);
		return logger;
	}
	fs.mkdirSync(path.dirname(settings.file), { recursive: true });
	if (isRollingPath(settings.file)) pruneOldRollingLogs(path.dirname(settings.file));
	let currentFileBytes = getCurrentLogFileBytes(settings.file);
	let warnedAboutSizeCap = false;
	logger.attachTransport((logObj) => {
		try {
			const time = formatLocalIsoWithOffset(logObj.date ?? /* @__PURE__ */ new Date());
			const payload = `${JSON.stringify({
				...logObj,
				time
			})}\n`;
			const payloadBytes = Buffer.byteLength(payload, "utf8");
			const nextBytes = currentFileBytes + payloadBytes;
			if (nextBytes > settings.maxFileBytes) {
				if (!warnedAboutSizeCap) {
					warnedAboutSizeCap = true;
					const warningLine = JSON.stringify({
						time: formatLocalIsoWithOffset(/* @__PURE__ */ new Date()),
						level: "warn",
						subsystem: "logging",
						message: `log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}`
					});
					appendLogLine(settings.file, `${warningLine}\n`);
					process.stderr.write(`[openclaw] log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}\n`);
				}
				return;
			}
			if (appendLogLine(settings.file, payload)) currentFileBytes = nextBytes;
		} catch {}
	});
	for (const transport of externalTransports) attachExternalTransport(logger, transport);
	return logger;
}
function resolveMaxLogFileBytes(raw) {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return DEFAULT_MAX_LOG_FILE_BYTES;
}
function getCurrentLogFileBytes(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}
function appendLogLine(file, line) {
	try {
		fs.appendFileSync(file, line, { encoding: "utf8" });
		return true;
	} catch {
		return false;
	}
}
function getLogger() {
	const settings = resolveSettings();
	const cachedLogger = loggingState.cachedLogger;
	const cachedSettings = loggingState.cachedSettings;
	if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
		loggingState.cachedLogger = buildLogger(settings);
		loggingState.cachedSettings = settings;
	}
	return loggingState.cachedLogger;
}
function getChildLogger(bindings, opts) {
	const base = getLogger();
	const minLevel = opts?.level ? levelToMinLevel(opts.level) : void 0;
	const name = bindings ? JSON.stringify(bindings) : void 0;
	return base.getSubLogger({
		name,
		minLevel,
		prefix: bindings ? [name ?? ""] : []
	});
}
function formatLocalDate(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function defaultRollingPathForToday() {
	const today = formatLocalDate(/* @__PURE__ */ new Date());
	return path.join(DEFAULT_LOG_DIR, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}
function isRollingPath(file) {
	const base = path.basename(file);
	return base.startsWith(`${LOG_PREFIX}-`) && base.endsWith(LOG_SUFFIX) && base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length;
}
function pruneOldRollingLogs(dir) {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const cutoff = Date.now() - MAX_LOG_AGE_MS;
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) continue;
			const fullPath = path.join(dir, entry.name);
			try {
				if (fs.statSync(fullPath).mtimeMs < cutoff) fs.rmSync(fullPath, { force: true });
			} catch {}
		}
	} catch {}
}
//#endregion
//#region src/terminal/palette.ts
const LOBSTER_PALETTE = {
	accent: "#FF5A2D",
	accentBright: "#FF7A3D",
	accentDim: "#D14A22",
	info: "#FF8A5B",
	success: "#2FBF71",
	warn: "#FFB020",
	error: "#E23D2D",
	muted: "#8B7F77"
};
//#endregion
//#region src/terminal/theme.ts
const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;
const hex = (value) => baseChalk.hex(value);
const theme = {
	accent: hex(LOBSTER_PALETTE.accent),
	accentBright: hex(LOBSTER_PALETTE.accentBright),
	accentDim: hex(LOBSTER_PALETTE.accentDim),
	info: hex(LOBSTER_PALETTE.info),
	success: hex(LOBSTER_PALETTE.success),
	warn: hex(LOBSTER_PALETTE.warn),
	error: hex(LOBSTER_PALETTE.error),
	muted: hex(LOBSTER_PALETTE.muted),
	heading: baseChalk.bold.hex(LOBSTER_PALETTE.accent),
	command: hex(LOBSTER_PALETTE.accentBright),
	option: hex(LOBSTER_PALETTE.warn)
};
//#endregion
//#region src/globals.ts
let globalVerbose = false;
function isVerbose() {
	return globalVerbose;
}
theme.success;
theme.warn;
theme.info;
theme.error;
//#endregion
//#region src/terminal/progress-line.ts
let activeStream = null;
function clearActiveProgressLine() {
	if (!activeStream?.isTTY) return;
	activeStream.write("\r\x1B[2K");
}
//#endregion
//#region src/runtime.ts
function shouldEmitRuntimeLog(env = process.env) {
	if (env.VITEST !== "true") return true;
	if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") return true;
	return typeof console.log.mock === "object";
}
function createRuntimeIo() {
	return {
		log: (...args) => {
			if (!shouldEmitRuntimeLog()) return;
			clearActiveProgressLine();
			console.log(...args);
		},
		error: (...args) => {
			clearActiveProgressLine();
			console.error(...args);
		}
	};
}
({ ...createRuntimeIo() });
//#endregion
//#region src/terminal/ansi.ts
const ANSI_SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";
new RegExp(ANSI_SGR_PATTERN, "g");
new RegExp(OSC8_PATTERN, "g");
typeof Intl !== "undefined" && "Segmenter" in Intl && new Intl.Segmenter(void 0, { granularity: "grapheme" });
//#endregion
//#region src/logging/console.ts
const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
const loadConfigFallbackDefault = () => {
	try {
		return (requireConfig?.("../config/config.js"))?.loadConfig?.().logging;
	} catch {
		return;
	}
};
let loadConfigFallback = loadConfigFallbackDefault;
function normalizeConsoleLevel(level) {
	if (isVerbose()) return "debug";
	if (!level && process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1") return "silent";
	return normalizeLogLevel(level, "info");
}
function normalizeConsoleStyle(style) {
	if (style === "compact" || style === "json" || style === "pretty") return style;
	if (!process.stdout.isTTY) return "compact";
	return "pretty";
}
function resolveConsoleSettings() {
	const envLevel = resolveEnvLogLevelOverride();
	if (process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1" && !isVerbose() && !envLevel && !loggingState.overrideSettings) return {
		level: "silent",
		style: normalizeConsoleStyle(void 0)
	};
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg) if (loggingState.resolvingConsoleSettings) cfg = void 0;
	else {
		loggingState.resolvingConsoleSettings = true;
		try {
			cfg = loadConfigFallback();
		} finally {
			loggingState.resolvingConsoleSettings = false;
		}
	}
	return {
		level: envLevel ?? normalizeConsoleLevel(cfg?.consoleLevel),
		style: normalizeConsoleStyle(cfg?.consoleStyle)
	};
}
function consoleSettingsChanged(a, b) {
	if (!a) return true;
	return a.level !== b.level || a.style !== b.style;
}
function getConsoleSettings() {
	const settings = resolveConsoleSettings();
	const cached = loggingState.cachedConsoleSettings;
	if (!cached || consoleSettingsChanged(cached, settings)) loggingState.cachedConsoleSettings = settings;
	return loggingState.cachedConsoleSettings;
}
function shouldLogSubsystemToConsole(subsystem) {
	const filter = loggingState.consoleSubsystemFilter;
	if (!filter || filter.length === 0) return true;
	return filter.some((prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`));
}
function formatConsoleTimestamp(style) {
	const now = /* @__PURE__ */ new Date();
	if (style === "pretty") return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
	return formatLocalIsoWithOffset(now);
}
//#endregion
//#region src/logging/subsystem.ts
function shouldLogToConsole(level, settings) {
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
(() => {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return null;
	try {
		const utilNamespace = getBuiltinModule("util");
		return typeof utilNamespace.inspect === "function" ? utilNamespace.inspect : null;
	} catch {
		return null;
	}
})();
function isRichConsoleEnv() {
	const term = (process.env.TERM ?? "").toLowerCase();
	if (process.env.COLORTERM || process.env.TERM_PROGRAM) return true;
	return term.length > 0 && term !== "dumb";
}
function getColorForConsole() {
	const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
	if (process.env.NO_COLOR && !hasForceColor) return new Chalk({ level: 0 });
	return Boolean(process.stdout.isTTY || process.stderr.isTTY) || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
}
const SUBSYSTEM_COLORS = [
	"cyan",
	"green",
	"yellow",
	"blue",
	"magenta",
	"red"
];
const SUBSYSTEM_COLOR_OVERRIDES = { "gmail-watcher": "blue" };
const SUBSYSTEM_PREFIXES_TO_DROP = [
	"gateway",
	"channels",
	"providers"
];
const SUBSYSTEM_MAX_SEGMENTS = 2;
const CHANNEL_SUBSYSTEM_PREFIXES = new Set([
	"telegram",
	"whatsapp",
	"discord",
	"irc",
	"googlechat",
	"slack",
	"signal",
	"imessage"
]);
function pickSubsystemColor(color, subsystem) {
	const override = SUBSYSTEM_COLOR_OVERRIDES[subsystem];
	if (override) return color[override];
	let hash = 0;
	for (let i = 0; i < subsystem.length; i += 1) hash = hash * 31 + subsystem.charCodeAt(i) | 0;
	return color[SUBSYSTEM_COLORS[Math.abs(hash) % SUBSYSTEM_COLORS.length]];
}
function formatSubsystemForConsole(subsystem) {
	const parts = subsystem.split("/").filter(Boolean);
	const original = parts.join("/") || subsystem;
	while (parts.length > 0 && SUBSYSTEM_PREFIXES_TO_DROP.includes(parts[0])) parts.shift();
	if (parts.length === 0) return original;
	if (CHANNEL_SUBSYSTEM_PREFIXES.has(parts[0])) return parts[0];
	if (parts.length > SUBSYSTEM_MAX_SEGMENTS) return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");
	return parts.join("/");
}
function stripRedundantSubsystemPrefixForConsole(message, displaySubsystem) {
	if (!displaySubsystem) return message;
	if (message.startsWith("[")) {
		const closeIdx = message.indexOf("]");
		if (closeIdx > 1) {
			if (message.slice(1, closeIdx).toLowerCase() === displaySubsystem.toLowerCase()) {
				let i = closeIdx + 1;
				while (message[i] === " ") i += 1;
				return message.slice(i);
			}
		}
	}
	if (message.slice(0, displaySubsystem.length).toLowerCase() !== displaySubsystem.toLowerCase()) return message;
	const next = message.slice(displaySubsystem.length, displaySubsystem.length + 1);
	if (next !== ":" && next !== " ") return message;
	let i = displaySubsystem.length;
	while (message[i] === " ") i += 1;
	if (message[i] === ":") i += 1;
	while (message[i] === " ") i += 1;
	return message.slice(i);
}
function formatConsoleLine(opts) {
	const displaySubsystem = opts.style === "json" ? opts.subsystem : formatSubsystemForConsole(opts.subsystem);
	if (opts.style === "json") return JSON.stringify({
		time: formatConsoleTimestamp("json"),
		level: opts.level,
		subsystem: displaySubsystem,
		message: opts.message,
		...opts.meta
	});
	const color = getColorForConsole();
	const prefix = `[${displaySubsystem}]`;
	const prefixColor = pickSubsystemColor(color, displaySubsystem);
	const levelColor = opts.level === "error" || opts.level === "fatal" ? color.red : opts.level === "warn" ? color.yellow : opts.level === "debug" || opts.level === "trace" ? color.gray : color.cyan;
	const displayMessage = stripRedundantSubsystemPrefixForConsole(opts.message, displaySubsystem);
	return `${[(() => {
		if (opts.style === "pretty") return color.gray(formatConsoleTimestamp("pretty"));
		if (loggingState.consoleTimestampPrefix) return color.gray(formatConsoleTimestamp(opts.style));
		return "";
	})(), prefixColor(prefix)].filter(Boolean).join(" ")} ${levelColor(displayMessage)}`;
}
function writeConsoleLine(level, line) {
	clearActiveProgressLine();
	const sanitized = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" ? line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?").replace(/[\uD800-\uDFFF]/g, "?") : line;
	const sink = loggingState.rawConsole ?? console;
	if (loggingState.forceConsoleToStderr || level === "error" || level === "fatal") (sink.error ?? console.error)(sanitized);
	else if (level === "warn") (sink.warn ?? console.warn)(sanitized);
	else (sink.log ?? console.log)(sanitized);
}
function shouldSuppressProbeConsoleLine(params) {
	if (isVerbose()) return false;
	if (params.level === "error" || params.level === "fatal") return false;
	if (!(params.subsystem === "agent/embedded" || params.subsystem.startsWith("agent/embedded/") || params.subsystem === "model-fallback" || params.subsystem.startsWith("model-fallback/"))) return false;
	if ((typeof params.meta?.runId === "string" ? params.meta.runId : typeof params.meta?.sessionId === "string" ? params.meta.sessionId : void 0)?.startsWith("probe-")) return true;
	return /(sessionId|runId)=probe-/.test(params.message);
}
function logToFile(fileLogger, level, message, meta) {
	if (level === "silent") return;
	const method = fileLogger[level];
	if (typeof method !== "function") return;
	if (meta && Object.keys(meta).length > 0) method.call(fileLogger, meta, message);
	else method.call(fileLogger, message);
}
function createSubsystemLogger(subsystem) {
	let fileLogger = null;
	const getFileLogger = () => {
		if (!fileLogger) fileLogger = getChildLogger({ subsystem });
		return fileLogger;
	};
	const emit = (level, message, meta) => {
		const consoleSettings = getConsoleSettings();
		const consoleEnabled = shouldLogToConsole(level, { level: consoleSettings.level }) && shouldLogSubsystemToConsole(subsystem);
		const fileEnabled = isFileLogLevelEnabled(level);
		if (!consoleEnabled && !fileEnabled) return;
		let consoleMessageOverride;
		let fileMeta = meta;
		if (meta && Object.keys(meta).length > 0) {
			const { consoleMessage, ...rest } = meta;
			if (typeof consoleMessage === "string") consoleMessageOverride = consoleMessage;
			fileMeta = Object.keys(rest).length > 0 ? rest : void 0;
		}
		if (fileEnabled) logToFile(getFileLogger(), level, message, fileMeta);
		if (!consoleEnabled) return;
		const consoleMessage = consoleMessageOverride ?? message;
		if (shouldSuppressProbeConsoleLine({
			level,
			subsystem,
			message: consoleMessage,
			meta: fileMeta
		})) return;
		writeConsoleLine(level, formatConsoleLine({
			level,
			subsystem,
			message: consoleSettings.style === "json" ? message : consoleMessage,
			style: consoleSettings.style,
			meta: fileMeta
		}));
	};
	const isConsoleEnabled = (level) => {
		return shouldLogToConsole(level, { level: getConsoleSettings().level }) && shouldLogSubsystemToConsole(subsystem);
	};
	const isFileEnabled = (level) => isFileLogLevelEnabled(level);
	return {
		subsystem,
		isEnabled: (level, target = "any") => {
			if (target === "console") return isConsoleEnabled(level);
			if (target === "file") return isFileEnabled(level);
			return isConsoleEnabled(level) || isFileEnabled(level);
		},
		trace: (message, meta) => emit("trace", message, meta),
		debug: (message, meta) => emit("debug", message, meta),
		info: (message, meta) => emit("info", message, meta),
		warn: (message, meta) => emit("warn", message, meta),
		error: (message, meta) => emit("error", message, meta),
		fatal: (message, meta) => emit("fatal", message, meta),
		raw: (message) => {
			if (isFileEnabled("info")) logToFile(getFileLogger(), "info", message, { raw: true });
			if (isConsoleEnabled("info")) {
				if (shouldSuppressProbeConsoleLine({
					level: "info",
					subsystem,
					message
				})) return;
				writeConsoleLine("info", message);
			}
		},
		child: (name) => createSubsystemLogger(`${subsystem}/${name}`)
	};
}
//#endregion
//#region src/hooks/internal-hooks.ts
/**
* Registry of hook handlers by event key.
*
* Uses a globalThis singleton so that registerInternalHook and
* triggerInternalHook always share the same Map even when the bundler
* emits multiple copies of this module into separate chunks (bundle
* splitting). Without the singleton, handlers registered in one chunk
* are invisible to triggerInternalHook in another chunk, causing hooks
* to silently fire with zero handlers.
*/
const _g = globalThis;
_g.__openclaw_internal_hook_handlers__ ??= /* @__PURE__ */ new Map();
createSubsystemLogger("internal-hooks");
//#endregion
//#region src/utils.ts
function resolveUserPath(input, env = process.env, homedir = os.homedir) {
	if (!input) return "";
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = expandHomePrefix(trimmed, {
			home: resolveRequiredHomeDir(env, homedir),
			env,
			homedir
		});
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
function resolveConfigDir(env = process.env, homedir = os.homedir) {
	const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (override) return resolveUserPath(override, env, homedir);
	const newDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
	try {
		if (fs.existsSync(newDir)) return newDir;
	} catch {}
	return newDir;
}
resolveConfigDir();
//#endregion
//#region src/plugins/registry.ts
function createEmptyPluginRegistry() {
	return {
		plugins: [],
		tools: [],
		hooks: [],
		typedHooks: [],
		channels: [],
		providers: [],
		gatewayHandlers: {},
		httpRoutes: [],
		cliRegistrars: [],
		services: [],
		commands: [],
		diagnostics: []
	};
}
//#endregion
//#region src/plugins/runtime.ts
const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
const state = (() => {
	const globalState = globalThis;
	if (!globalState[REGISTRY_STATE]) globalState[REGISTRY_STATE] = {
		registry: createEmptyPluginRegistry(),
		key: null,
		version: 0
	};
	return globalState[REGISTRY_STATE];
})();
function requireActivePluginRegistry() {
	if (!state.registry) {
		state.registry = createEmptyPluginRegistry();
		state.version += 1;
	}
	return state.registry;
}
//#endregion
//#region src/plugins/http-registry.ts
function registerPluginHttpRoute(params) {
	const registry = params.registry ?? requireActivePluginRegistry();
	const routes = registry.httpRoutes ?? [];
	registry.httpRoutes = routes;
	const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
	const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
	if (!normalizedPath) {
		params.log?.(`plugin: webhook path missing${suffix}`);
		return () => {};
	}
	const routeMatch = params.match ?? "exact";
	const overlappingRoute = findOverlappingPluginHttpRoute(routes, {
		path: normalizedPath,
		match: routeMatch
	});
	if (overlappingRoute && overlappingRoute.auth !== params.auth) {
		params.log?.(`plugin: route overlap denied at ${normalizedPath} (${routeMatch}, ${params.auth})${suffix}; overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) owned by ${overlappingRoute.pluginId ?? "unknown-plugin"} (${overlappingRoute.source ?? "unknown-source"})`);
		return () => {};
	}
	const existingIndex = routes.findIndex((entry) => entry.path === normalizedPath && entry.match === routeMatch);
	if (existingIndex >= 0) {
		const existing = routes[existingIndex];
		if (!existing) return () => {};
		if (!params.replaceExisting) {
			params.log?.(`plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId ?? "unknown-plugin"} (${existing.source ?? "unknown-source"})`);
			return () => {};
		}
		if (existing.pluginId && params.pluginId && existing.pluginId !== params.pluginId) {
			params.log?.(`plugin: route replacement denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId}`);
			return () => {};
		}
		const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
		params.log?.(`plugin: replacing stale webhook path ${normalizedPath} (${routeMatch})${suffix}${pluginHint}`);
		routes.splice(existingIndex, 1);
	}
	const entry = {
		path: normalizedPath,
		handler: params.handler,
		auth: params.auth,
		match: routeMatch,
		pluginId: params.pluginId,
		source: params.source
	};
	routes.push(entry);
	return () => {
		const index = routes.indexOf(entry);
		if (index >= 0) routes.splice(index, 1);
	};
}
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
Object.freeze({
	windowMs: 6e4,
	maxRequests: 120,
	maxTrackedKeys: 4096
});
Object.freeze({
	maxTrackedKeys: 4096,
	ttlMs: 360 * 6e4,
	logEvery: 25
});
Object.freeze([
	400,
	401,
	408,
	413,
	415,
	429
]);
function createFixedWindowRateLimiter(options) {
	const windowMs = Math.max(1, Math.floor(options.windowMs));
	const maxRequests = Math.max(1, Math.floor(options.maxRequests));
	const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));
	const pruneIntervalMs = Math.max(1, Math.floor(options.pruneIntervalMs ?? windowMs));
	const state = /* @__PURE__ */ new Map();
	let lastPruneMs = 0;
	const touch = (key, value) => {
		state.delete(key);
		state.set(key, value);
	};
	const prune = (nowMs) => {
		for (const [key, entry] of state) if (nowMs - entry.windowStartMs >= windowMs) state.delete(key);
	};
	return {
		isRateLimited: (key, nowMs = Date.now()) => {
			if (!key) return false;
			if (nowMs - lastPruneMs >= pruneIntervalMs) {
				prune(nowMs);
				lastPruneMs = nowMs;
			}
			const existing = state.get(key);
			if (!existing || nowMs - existing.windowStartMs >= windowMs) {
				touch(key, {
					count: 1,
					windowStartMs: nowMs
				});
				pruneMapToMaxSize(state, maxTrackedKeys);
				return false;
			}
			const nextCount = existing.count + 1;
			touch(key, {
				count: nextCount,
				windowStartMs: existing.windowStartMs
			});
			pruneMapToMaxSize(state, maxTrackedKeys);
			return nextCount > maxRequests;
		},
		size: () => state.size,
		clear: () => {
			state.clear();
			lastPruneMs = 0;
		}
	};
}
//#endregion
export { DEFAULT_ACCOUNT_ID, buildChannelConfigSchema, createFixedWindowRateLimiter, emptyPluginConfigSchema, isRequestBodyLimitError, readRequestBodyWithLimit, registerPluginHttpRoute, requestBodyErrorToText, setAccountEnabledInConfigSection };
