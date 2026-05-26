import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { n as MODEL_THINKING_FORMATS, t as MODEL_APIS } from "./types.models-lqH0KLkn.js";
import { At as boolean, Bt as discriminatedUnion, Et as array, Kn as tuple, Nn as record, Rn as string, St as _null, Tn as object, Xn as union, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { n as ZodIssueCode } from "./compat-bCpUj7Jq.js";
import { a as formatExecSecretRefIdValidationMessage, o as isValidExecSecretRefId, s as isValidFileSecretRefId } from "./ref-contract-D_h_G00C.js";
import { t as isSafeExecutableValue } from "./exec-safety-1iu4aOkR.js";
import { t as sensitive } from "./zod-schema.sensitive-3GVmnUbm.js";
import path from "node:path";
//#region src/config/zod-schema.allowdeny.ts
const AllowDenyActionSchema = union([literal("allow"), literal("deny")]);
const AllowDenyChatTypeSchema = union([
	literal("direct"),
	literal("group"),
	literal("channel"),
	literal("dm")
]).optional();
function createAllowDenyChannelRulesSchema() {
	return object({
		default: AllowDenyActionSchema.optional(),
		rules: array(object({
			action: AllowDenyActionSchema,
			match: object({
				channel: string().optional(),
				chatType: AllowDenyChatTypeSchema,
				keyPrefix: string().optional(),
				rawKeyPrefix: string().optional()
			}).strict().optional()
		}).strict()).optional()
	}).strict().optional();
}
//#endregion
//#region src/config/zod-schema.core.ts
const ENV_SECRET_REF_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
function isAbsolutePath(value) {
	return path.isAbsolute(value) || WINDOWS_ABS_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}
const SecretRefSchema = discriminatedUnion("source", [
	object({
		source: literal("env"),
		provider: string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\")."),
		id: string().regex(ENV_SECRET_REF_ID_PATTERN, "Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: \"OPENAI_API_KEY\").")
	}).strict(),
	object({
		source: literal("file"),
		provider: string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\")."),
		id: string().refine(isValidFileSecretRefId, "File secret reference id must be an absolute JSON pointer (example: \"/providers/openai/apiKey\"), or \"value\" for singleValue mode.")
	}).strict(),
	object({
		source: literal("exec"),
		provider: string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\")."),
		id: string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage())
	}).strict()
]);
const SecretInputSchema = union([string(), SecretRefSchema]);
const SecretProviderSchema = discriminatedUnion("source", [
	object({
		source: literal("env"),
		allowlist: array(string().regex(ENV_SECRET_REF_ID_PATTERN)).max(256).optional()
	}).strict(),
	object({
		source: literal("file"),
		path: string().min(1),
		mode: union([literal("singleValue"), literal("json")]).optional(),
		timeoutMs: number().int().positive().max(12e4).optional(),
		maxBytes: number().int().positive().max(20 * 1024 * 1024).optional(),
		allowInsecurePath: boolean().optional()
	}).strict(),
	object({
		source: literal("exec"),
		command: string().min(1).refine((value) => isSafeExecutableValue(value), "secrets.providers.*.command is unsafe.").refine((value) => isAbsolutePath(value), "secrets.providers.*.command must be an absolute path."),
		args: array(string().max(1024)).max(128).optional(),
		timeoutMs: number().int().positive().max(12e4).optional(),
		noOutputTimeoutMs: number().int().positive().max(12e4).optional(),
		maxOutputBytes: number().int().positive().max(20 * 1024 * 1024).optional(),
		jsonOnly: boolean().optional(),
		env: record(string(), string()).optional(),
		passEnv: array(string().regex(ENV_SECRET_REF_ID_PATTERN)).max(128).optional(),
		trustedDirs: array(string().min(1).refine((value) => isAbsolutePath(value), "trustedDirs entries must be absolute paths.")).max(64).optional(),
		allowInsecurePath: boolean().optional(),
		allowSymlinkCommand: boolean().optional()
	}).strict()
]);
const SecretsConfigSchema = object({
	providers: object({}).catchall(SecretProviderSchema).optional(),
	defaults: object({
		env: string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
		file: string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
		exec: string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional()
	}).strict().optional(),
	resolution: object({
		maxProviderConcurrency: number().int().positive().max(16).optional(),
		maxRefsPerProvider: number().int().positive().max(4096).optional(),
		maxBatchBytes: number().int().positive().max(5 * 1024 * 1024).optional()
	}).strict().optional()
}).strict().optional();
const ModelApiSchema = _enum(MODEL_APIS);
const ModelCompatSchema = object({
	supportsStore: boolean().optional(),
	supportsPromptCacheKey: boolean().optional(),
	supportsDeveloperRole: boolean().optional(),
	supportsReasoningEffort: boolean().optional(),
	supportsUsageInStreaming: boolean().optional(),
	supportsTools: boolean().optional(),
	supportsStrictMode: boolean().optional(),
	requiresStringContent: boolean().optional(),
	strictMessageKeys: boolean().optional(),
	visibleReasoningDetailTypes: array(string().min(1)).optional(),
	supportedReasoningEfforts: array(string().min(1)).optional(),
	reasoningEffortMap: record(string().min(1), string().min(1)).optional(),
	maxTokensField: union([literal("max_completion_tokens"), literal("max_tokens")]).optional(),
	thinkingFormat: _enum(MODEL_THINKING_FORMATS).optional(),
	requiresToolResultName: boolean().optional(),
	requiresAssistantAfterToolResult: boolean().optional(),
	requiresThinkingAsText: boolean().optional(),
	toolSchemaProfile: string().optional(),
	unsupportedToolSchemaKeywords: array(string().min(1)).optional(),
	nativeWebSearchTool: boolean().optional(),
	toolCallArgumentsEncoding: string().optional(),
	requiresMistralToolIds: boolean().optional(),
	requiresOpenAiAnthropicToolPayload: boolean().optional()
}).strict().optional();
const ConfiguredProviderRequestTlsSchema = object({
	ca: SecretInputSchema.optional().register(sensitive),
	cert: SecretInputSchema.optional().register(sensitive),
	key: SecretInputSchema.optional().register(sensitive),
	passphrase: SecretInputSchema.optional().register(sensitive),
	serverName: string().optional(),
	insecureSkipVerify: boolean().optional()
}).strict().optional();
const ConfiguredProviderRequestAuthSchema = union([
	object({ mode: literal("provider-default") }).strict(),
	object({
		mode: literal("authorization-bearer"),
		token: SecretInputSchema.register(sensitive)
	}).strict(),
	object({
		mode: literal("header"),
		headerName: string().min(1),
		value: SecretInputSchema.register(sensitive),
		prefix: string().optional()
	}).strict()
]).optional();
const ConfiguredProviderRequestProxySchema = union([object({
	mode: literal("env-proxy"),
	tls: ConfiguredProviderRequestTlsSchema
}).strict(), object({
	mode: literal("explicit-proxy"),
	url: string().min(1),
	tls: ConfiguredProviderRequestTlsSchema
}).strict()]).optional();
const ConfiguredProviderRequestFields = {
	headers: record(string(), SecretInputSchema.register(sensitive)).optional(),
	auth: ConfiguredProviderRequestAuthSchema,
	proxy: ConfiguredProviderRequestProxySchema,
	tls: ConfiguredProviderRequestTlsSchema
};
const ConfiguredProviderRequestSchema = object(ConfiguredProviderRequestFields).strict().optional();
const ConfiguredModelProviderRequestSchema = object({
	...ConfiguredProviderRequestFields,
	allowPrivateNetwork: boolean().optional()
}).strict().optional();
const ModelAgentRuntimePolicySchema = object({ id: string().optional() }).strict().optional();
const ModelDefinitionSchema = object({
	id: string().min(1),
	name: string().min(1),
	api: ModelApiSchema.optional(),
	baseUrl: string().min(1).optional(),
	reasoning: boolean().optional(),
	input: array(union([
		literal("text"),
		literal("image"),
		literal("video"),
		literal("audio")
	])).optional(),
	cost: object({
		input: number().optional(),
		output: number().optional(),
		cacheRead: number().optional(),
		cacheWrite: number().optional(),
		tieredPricing: array(object({
			input: number(),
			output: number(),
			cacheRead: number(),
			cacheWrite: number(),
			range: union([tuple([number(), number()]), tuple([number()])])
		}).strict()).optional()
	}).strict().optional(),
	contextWindow: number().positive().optional(),
	contextTokens: number().int().positive().optional(),
	maxTokens: number().positive().optional(),
	params: record(string(), unknown()).optional(),
	agentRuntime: ModelAgentRuntimePolicySchema,
	headers: record(string(), string()).optional(),
	compat: ModelCompatSchema,
	metadataSource: literal("models-add").optional()
}).strict();
const ModelProviderLocalServiceSchema = object({
	command: string().min(1),
	args: array(string()).optional(),
	cwd: string().min(1).optional(),
	env: record(string(), string().register(sensitive)).optional(),
	healthUrl: string().min(1).optional(),
	readyTimeoutMs: number().int().positive().optional(),
	idleStopMs: number().int().nonnegative().optional()
}).strict().optional();
const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set([
	"amazon-bedrock",
	"amazon-bedrock-mantle",
	"anthropic",
	"anthropic-vertex",
	"arcee",
	"byteplus",
	"byteplus-plan",
	"cerebras",
	"chutes",
	"cloudflare-ai-gateway",
	"codex",
	"comfy",
	"copilot-proxy",
	"dashscope",
	"deepinfra",
	"deepseek",
	"fal",
	"fireworks",
	"github-copilot",
	"google",
	"google-antigravity",
	"google-gemini-cli",
	"google-vertex",
	"groq",
	"huggingface",
	"kilocode",
	"kimi",
	"kimi-coding",
	"litellm",
	"lmstudio",
	"microsoft-foundry",
	"minimax",
	"minimax-portal",
	"mistral",
	"modelstudio",
	"moonshot",
	"nvidia",
	"ollama",
	"openai",
	"openai-codex",
	"opencode",
	"opencode-go",
	"openrouter",
	"qianfan",
	"qwen",
	"qwencloud",
	"sglang",
	"stepfun",
	"stepfun-plan",
	"synthetic",
	"tencent-tokenhub",
	"together",
	"venice",
	"vercel-ai-gateway",
	"vllm",
	"volcengine",
	"volcengine-plan",
	"vydra",
	"xai",
	"xiaomi",
	"zai"
]);
function isBuiltInModelProviderOverlayId(providerId) {
	return BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS.has(normalizeProviderId(providerId));
}
const ModelProviderSchema = object({
	baseUrl: string().min(1).optional(),
	apiKey: SecretInputSchema.optional().register(sensitive),
	auth: union([
		literal("api-key"),
		literal("aws-sdk"),
		literal("oauth"),
		literal("token")
	]).optional(),
	api: ModelApiSchema.optional(),
	contextWindow: number().positive().optional(),
	contextTokens: number().int().positive().optional(),
	maxTokens: number().positive().optional(),
	timeoutSeconds: number().int().positive().optional(),
	injectNumCtxForOpenAICompat: boolean().optional(),
	params: record(string(), unknown()).optional(),
	agentRuntime: ModelAgentRuntimePolicySchema,
	localService: ModelProviderLocalServiceSchema,
	headers: record(string(), SecretInputSchema.register(sensitive)).optional(),
	authHeader: boolean().optional(),
	request: ConfiguredModelProviderRequestSchema,
	models: array(ModelDefinitionSchema).optional()
}).strict();
const ModelProvidersSchema = record(string(), ModelProviderSchema).superRefine((providers, ctx) => {
	for (const [providerId, provider] of Object.entries(providers)) {
		if (isBuiltInModelProviderOverlayId(providerId)) continue;
		if (!provider.baseUrl) ctx.addIssue({
			code: "custom",
			path: [providerId, "baseUrl"],
			message: "custom model providers must declare baseUrl; provider overlays without baseUrl are only supported for bundled providers"
		});
		if (!Array.isArray(provider.models)) ctx.addIssue({
			code: "custom",
			path: [providerId, "models"],
			message: "custom model providers must declare models; provider overlays without models are only supported for bundled providers"
		});
	}
});
const ModelPricingConfigSchema = object({ enabled: boolean().optional() }).strict().optional();
const ModelsConfigSchema = object({
	mode: union([literal("merge"), literal("replace")]).optional(),
	providers: ModelProvidersSchema.optional(),
	pricing: ModelPricingConfigSchema
}).strict().optional();
const VisibleRepliesValueSchema = _enum(["automatic", "message_tool"]);
const AmbientGroupInboundSchema = _enum(["user_request", "room_event"]);
const VisibleRepliesSchema = union([VisibleRepliesValueSchema, boolean()]).overwrite((value) => {
	if (value === true) return "automatic";
	if (value === false) return "message_tool";
	return value;
});
const GroupChatSchema = object({
	mentionPatterns: array(string()).optional(),
	historyLimit: number().int().positive().optional(),
	unmentionedInbound: AmbientGroupInboundSchema.optional(),
	visibleReplies: VisibleRepliesSchema.optional()
}).strict().optional();
const DmConfigSchema = object({ historyLimit: number().int().min(0).optional() }).strict();
const IdentitySchema = object({
	name: string().optional(),
	theme: string().optional(),
	emoji: string().optional(),
	avatar: string().optional()
}).strict().optional();
const QueueModeSchema = union([
	literal("steer"),
	literal("followup"),
	literal("collect"),
	literal("interrupt")
]);
const QueueDropSchema = union([
	literal("old"),
	literal("new"),
	literal("summarize")
]);
const ReplyToModeSchema = union([
	literal("off"),
	literal("first"),
	literal("all"),
	literal("batched")
]);
const TypingModeSchema = union([
	literal("never"),
	literal("instant"),
	literal("thinking"),
	literal("message")
]);
const GroupPolicySchema = _enum([
	"open",
	"disabled",
	"allowlist"
]);
const DmPolicySchema = _enum([
	"pairing",
	"allowlist",
	"open",
	"disabled"
]);
const ContextVisibilityModeSchema = _enum([
	"all",
	"allowlist",
	"allowlist_quote"
]);
const BlockStreamingCoalesceSchema = object({
	minChars: number().int().positive().optional(),
	maxChars: number().int().positive().optional(),
	idleMs: number().int().nonnegative().optional()
}).strict();
const ReplyRuntimeConfigSchemaShape = {
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	dms: record(string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: number().int().positive().optional(),
	chunkMode: _enum(["length", "newline"]).optional(),
	blockStreaming: boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	responsePrefix: string().optional(),
	mediaMaxMb: number().positive().optional()
};
const BlockStreamingChunkSchema = object({
	minChars: number().int().positive().optional(),
	maxChars: number().int().positive().optional(),
	breakPreference: union([
		literal("paragraph"),
		literal("newline"),
		literal("sentence")
	]).optional()
}).strict();
const MarkdownConfigSchema = object({ tables: _enum([
	"off",
	"bullets",
	"code",
	"block"
]).optional() }).strict().optional();
const TtsProviderSchema = string().min(1);
const TtsModeSchema = _enum(["final", "all"]);
const TtsAutoSchema = _enum([
	"off",
	"always",
	"inbound",
	"tagged"
]);
const TtsProviderConfigSchema = object({ apiKey: SecretInputSchema.optional().register(sensitive) }).catchall(union([
	string(),
	number(),
	boolean(),
	_null(),
	array(unknown()),
	record(string(), unknown())
]));
const TtsPersonaPromptSchema = object({
	profile: string().optional(),
	scene: string().optional(),
	sampleContext: string().optional(),
	style: string().optional(),
	accent: string().optional(),
	pacing: string().optional(),
	constraints: array(string()).optional()
}).strict();
const TtsPersonaSchema = object({
	label: string().optional(),
	description: string().optional(),
	provider: TtsProviderSchema.optional(),
	fallbackPolicy: union([
		literal("preserve-persona"),
		literal("provider-defaults"),
		literal("fail")
	]).optional(),
	prompt: TtsPersonaPromptSchema.optional(),
	providers: record(string(), TtsProviderConfigSchema).optional()
}).strict();
const TtsConfigSchema = object({
	auto: TtsAutoSchema.optional(),
	enabled: boolean().optional(),
	mode: TtsModeSchema.optional(),
	provider: TtsProviderSchema.optional(),
	persona: string().optional(),
	personas: record(string(), TtsPersonaSchema).optional(),
	summaryModel: string().optional(),
	modelOverrides: object({
		enabled: boolean().optional(),
		allowText: boolean().optional(),
		allowProvider: boolean().optional(),
		allowVoice: boolean().optional(),
		allowModelId: boolean().optional(),
		allowVoiceSettings: boolean().optional(),
		allowNormalization: boolean().optional(),
		allowSeed: boolean().optional()
	}).strict().optional(),
	providers: record(string(), TtsProviderConfigSchema).optional(),
	prefsPath: string().optional(),
	maxTextLength: number().int().min(1).optional(),
	timeoutMs: number().int().min(1e3).max(12e4).optional()
}).strict().optional();
const HumanDelaySchema = object({
	mode: union([
		literal("off"),
		literal("natural"),
		literal("custom")
	]).optional(),
	minMs: number().int().nonnegative().optional(),
	maxMs: number().int().nonnegative().optional()
}).strict();
const CliBackendWatchdogModeSchema = object({
	noOutputTimeoutMs: number().int().min(1e3).optional(),
	noOutputTimeoutRatio: number().min(.05).max(.95).optional(),
	minMs: number().int().min(1e3).optional(),
	maxMs: number().int().min(1e3).optional()
}).strict().optional();
const CliBackendOutputLimitsSchema = object({
	maxTurnRawChars: number().int().min(1024).max(64 * 1024 * 1024).optional(),
	maxTurnLines: number().int().min(100).max(1e5).optional()
}).strict().optional();
const CliBackendSchema = object({
	command: string(),
	args: array(string()).optional(),
	output: union([
		literal("json"),
		literal("text"),
		literal("jsonl")
	]).optional(),
	resumeOutput: union([
		literal("json"),
		literal("text"),
		literal("jsonl")
	]).optional(),
	jsonlDialect: literal("claude-stream-json").optional(),
	liveSession: literal("claude-stdio").optional(),
	input: union([literal("arg"), literal("stdin")]).optional(),
	maxPromptArgChars: number().int().positive().optional(),
	env: record(string(), string()).optional(),
	clearEnv: array(string()).optional(),
	modelArg: string().optional(),
	modelAliases: record(string(), string()).optional(),
	sessionArg: string().optional(),
	sessionArgs: array(string()).optional(),
	resumeArgs: array(string()).optional(),
	sessionMode: union([
		literal("always"),
		literal("existing"),
		literal("none")
	]).optional(),
	sessionIdFields: array(string()).optional(),
	systemPromptArg: string().optional(),
	systemPromptFileArg: string().optional(),
	systemPromptFileConfigArg: string().optional(),
	systemPromptFileConfigKey: string().optional(),
	systemPromptMode: union([literal("append"), literal("replace")]).optional(),
	systemPromptWhen: union([
		literal("first"),
		literal("always"),
		literal("never")
	]).optional(),
	imageArg: string().optional(),
	imageMode: union([literal("repeat"), literal("list")]).optional(),
	imagePathScope: union([literal("temp"), literal("workspace")]).optional(),
	serialize: boolean().optional(),
	reseedFromRawTranscriptWhenUncompacted: boolean().optional(),
	reliability: object({
		outputLimits: CliBackendOutputLimitsSchema,
		watchdog: object({
			fresh: CliBackendWatchdogModeSchema,
			resume: CliBackendWatchdogModeSchema
		}).strict().optional()
	}).strict().optional()
}).strict();
const normalizeAllowFrom = (values) => normalizeStringEntries(values);
const requireOpenAllowFrom = (params) => {
	if (params.policy !== "open") return;
	if (normalizeAllowFrom(params.allowFrom).includes("*")) return;
	params.ctx.addIssue({
		code: ZodIssueCode.custom,
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
		code: ZodIssueCode.custom,
		path: params.path,
		message: params.message
	});
};
const MSTeamsReplyStyleSchema = _enum(["thread", "top-level"]);
const RetryConfigSchema = object({
	attempts: number().int().min(1).optional(),
	minDelayMs: number().int().min(0).optional(),
	maxDelayMs: number().int().min(0).optional(),
	jitter: number().min(0).max(1).optional()
}).strict().optional();
const QueueModeBySurfaceSchema = object({
	whatsapp: QueueModeSchema.optional(),
	telegram: QueueModeSchema.optional(),
	discord: QueueModeSchema.optional(),
	irc: QueueModeSchema.optional(),
	googlechat: QueueModeSchema.optional(),
	slack: QueueModeSchema.optional(),
	mattermost: QueueModeSchema.optional(),
	signal: QueueModeSchema.optional(),
	imessage: QueueModeSchema.optional(),
	msteams: QueueModeSchema.optional(),
	webchat: QueueModeSchema.optional(),
	matrix: QueueModeSchema.optional()
}).strict().optional();
const DebounceMsBySurfaceSchema = record(string(), number().int().nonnegative()).optional();
const QueueSchema = object({
	mode: QueueModeSchema.optional(),
	byChannel: QueueModeBySurfaceSchema,
	debounceMs: number().int().nonnegative().optional(),
	debounceMsByChannel: DebounceMsBySurfaceSchema,
	cap: number().int().positive().optional(),
	drop: QueueDropSchema.optional()
}).strict().optional();
const InboundDebounceSchema = object({
	debounceMs: number().int().nonnegative().optional(),
	byChannel: DebounceMsBySurfaceSchema
}).strict().optional();
const TranscribeAudioSchema = object({
	command: array(string()).superRefine((value, ctx) => {
		const executable = value[0];
		if (!isSafeExecutableValue(executable)) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: [0],
			message: "expected safe executable name or path"
		});
	}),
	timeoutSeconds: number().int().positive().optional()
}).strict().optional();
const HexColorSchema = string().regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");
const ExecutableTokenSchema = string().refine(isSafeExecutableValue, "expected safe executable name or path");
const MediaUnderstandingScopeSchema = createAllowDenyChannelRulesSchema();
const MediaUnderstandingCapabilitiesSchema = array(union([
	literal("image"),
	literal("audio"),
	literal("video")
])).optional();
const MediaUnderstandingAttachmentsSchema = object({
	mode: union([literal("first"), literal("all")]).optional(),
	maxAttachments: number().int().positive().optional(),
	prefer: union([
		literal("first"),
		literal("last"),
		literal("path"),
		literal("url")
	]).optional()
}).strict().optional();
const DeepgramAudioSchema = object({
	detectLanguage: boolean().optional(),
	punctuate: boolean().optional(),
	smartFormat: boolean().optional()
}).strict().optional();
const ProviderOptionValueSchema = union([
	string(),
	number(),
	boolean()
]);
const ProviderOptionsSchema = record(string(), record(string(), ProviderOptionValueSchema)).optional();
const MediaUnderstandingRuntimeFields = {
	prompt: string().optional(),
	timeoutSeconds: number().int().positive().optional(),
	language: string().optional(),
	providerOptions: ProviderOptionsSchema,
	deepgram: DeepgramAudioSchema,
	baseUrl: string().optional(),
	headers: record(string(), string()).optional(),
	request: ConfiguredProviderRequestSchema
};
const MediaUnderstandingModelSchema = object({
	provider: string().optional(),
	model: string().optional(),
	capabilities: MediaUnderstandingCapabilitiesSchema,
	type: union([literal("provider"), literal("cli")]).optional(),
	command: string().optional(),
	args: array(string()).optional(),
	maxChars: number().int().positive().optional(),
	maxBytes: number().int().positive().optional(),
	...MediaUnderstandingRuntimeFields,
	profile: string().optional(),
	preferredProfile: string().optional()
}).strict().optional();
const ToolsMediaUnderstandingSchema = object({
	enabled: boolean().optional(),
	scope: MediaUnderstandingScopeSchema,
	maxBytes: number().int().positive().optional(),
	maxChars: number().int().positive().optional(),
	...MediaUnderstandingRuntimeFields,
	attachments: MediaUnderstandingAttachmentsSchema,
	models: array(MediaUnderstandingModelSchema).optional(),
	echoTranscript: boolean().optional(),
	echoFormat: string().optional()
}).strict().optional();
const ToolsMediaSchema = object({
	models: array(MediaUnderstandingModelSchema).optional(),
	concurrency: number().int().positive().optional(),
	asyncCompletion: object({ directSend: boolean().optional() }).strict().optional(),
	image: ToolsMediaUnderstandingSchema.optional(),
	audio: ToolsMediaUnderstandingSchema.optional(),
	video: ToolsMediaUnderstandingSchema.optional()
}).strict().optional();
const LinkModelSchema = object({
	type: literal("cli").optional(),
	command: string().min(1),
	args: array(string()).optional(),
	timeoutSeconds: number().int().positive().optional()
}).strict();
const ToolsLinksSchema = object({
	enabled: boolean().optional(),
	scope: MediaUnderstandingScopeSchema,
	maxLinks: number().int().positive().optional(),
	timeoutSeconds: number().int().positive().optional(),
	models: array(LinkModelSchema).optional()
}).strict().optional();
const NativeCommandsSettingSchema = union([boolean(), literal("auto")]);
const ProviderCommandsSchema = object({
	native: NativeCommandsSettingSchema.optional(),
	nativeSkills: NativeCommandsSettingSchema.optional()
}).strict().optional();
//#endregion
export { TtsAutoSchema as A, SecretInputSchema as C, ToolsLinksSchema as D, SecretsConfigSchema as E, VisibleRepliesSchema as F, isBuiltInModelProviderOverlayId as I, requireAllowlistAllowFrom as L, TtsModeSchema as M, TtsProviderSchema as N, ToolsMediaSchema as O, TypingModeSchema as P, requireOpenAllowFrom as R, RetryConfigSchema as S, SecretRefSchema as T, NativeCommandsSettingSchema as _, DmConfigSchema as a, ReplyRuntimeConfigSchemaShape as b, GroupChatSchema as c, HumanDelaySchema as d, IdentitySchema as f, ModelsConfigSchema as g, MarkdownConfigSchema as h, ContextVisibilityModeSchema as i, TtsConfigSchema as j, TranscribeAudioSchema as k, GroupPolicySchema as l, MSTeamsReplyStyleSchema as m, BlockStreamingCoalesceSchema as n, DmPolicySchema as o, InboundDebounceSchema as p, CliBackendSchema as r, ExecutableTokenSchema as s, BlockStreamingChunkSchema as t, HexColorSchema as u, ProviderCommandsSchema as v, SecretProviderSchema as w, ReplyToModeSchema as x, QueueSchema as y, createAllowDenyChannelRulesSchema as z };
