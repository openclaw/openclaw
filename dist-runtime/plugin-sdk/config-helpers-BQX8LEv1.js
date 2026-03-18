import { s as init_session_key } from "./session-key-BwICpQs5.js";
import { cn as DEFAULT_SECRET_PROVIDER_ALIAS, pn as init_types_secrets } from "./runtime-CDMAx_h4.js";
import path from "node:path";
import { z } from "zod";
//#region src/cli/cli-name.ts
const DEFAULT_CLI_NAME = "openclaw";
const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME]);
const CLI_PREFIX_RE$1 = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw)\b/;
function resolveCliName(argv = process.argv) {
	const argv1 = argv[1];
	if (!argv1) return DEFAULT_CLI_NAME;
	const base = path.basename(argv1).trim();
	if (KNOWN_CLI_NAMES.has(base)) return base;
	return DEFAULT_CLI_NAME;
}
function replaceCliName(command, cliName = resolveCliName()) {
	if (!command.trim()) return command;
	if (!CLI_PREFIX_RE$1.test(command)) return command;
	return command.replace(CLI_PREFIX_RE$1, (_match, runner) => {
		return `${runner ?? ""}${cliName}`;
	});
}
//#endregion
//#region src/cli/profile-utils.ts
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function isValidProfileName(value) {
	if (!value) return false;
	return PROFILE_NAME_RE.test(value);
}
function normalizeProfileName(raw) {
	const profile = raw?.trim();
	if (!profile) return null;
	if (profile.toLowerCase() === "default") return null;
	if (!isValidProfileName(profile)) return null;
	return profile;
}
//#endregion
//#region src/cli/command-format.ts
const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b|^openclaw\b/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;
function formatCliCommand(command, env = process.env) {
	const normalizedCommand = replaceCliName(command, resolveCliName());
	const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
	if (!profile) return normalizedCommand;
	if (!CLI_PREFIX_RE.test(normalizedCommand)) return normalizedCommand;
	if (PROFILE_FLAG_RE.test(normalizedCommand) || DEV_FLAG_RE.test(normalizedCommand)) return normalizedCommand;
	return normalizedCommand.replace(CLI_PREFIX_RE, (match) => `${match} --profile ${profile}`);
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
export { SINGLE_VALUE_FILE_REF_ID as $, QueueSchema as A, TtsAutoSchema as B, InboundDebounceSchema as C, ModelsConfigSchema as D, MarkdownTableModeSchema as E, SecretRefSchema as F, normalizeAllowFrom as G, TtsModeSchema as H, SecretsConfigSchema as I, sensitive as J, requireAllowlistAllowFrom as K, ToolsLinksSchema as L, ReplyToModeSchema as M, RetryConfigSchema as N, NativeCommandsSettingSchema as O, SecretInputSchema as P, SECRET_PROVIDER_ALIAS_PATTERN$1 as Q, ToolsMediaSchema as R, IdentitySchema as S, MarkdownConfigSchema as T, TtsProviderSchema as U, TtsConfigSchema as V, TypingModeSchema as W, EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN as X, createAllowDenyChannelRulesSchema as Y, FILE_SECRET_REF_ID_PATTERN as Z, ExecutableTokenSchema as _, formatPairingApproveHint as a, isSafeExecutableValue as at, HexColorSchema as b, AllowFromListSchema as c, buildNestedDmConfigSchema as d, formatExecSecretRefIdValidationMessage as et, BlockStreamingChunkSchema as f, DmPolicySchema as g, DmConfigSchema as h, buildAccountScopedDmSecurityPolicy as i, secretRefKey as it, ReplyRuntimeConfigSchemaShape as j, ProviderCommandsSchema as k, buildCatchallMultiAccountChannelSchema as l, CliBackendSchema as m, deleteAccountFromConfigSection as n, isValidFileSecretRefId as nt, parseOptionalDelimitedEntries as o, formatCliCommand as ot, BlockStreamingCoalesceSchema as p, requireOpenAllowFrom as q, setAccountEnabledInConfigSection as r, resolveDefaultSecretProviderAlias as rt, AllowFromEntrySchema as s, resolveCliName as st, clearAccountEntryFields as t, isValidExecSecretRefId as tt, buildChannelConfigSchema as u, GroupChatSchema as v, MSTeamsReplyStyleSchema as w, HumanDelaySchema as x, GroupPolicySchema as y, TranscribeAudioSchema as z };
