import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { An as preprocess, At as boolean, Et as array, Nn as record, Rn as string, Si as NEVER, Tn as object, Xn as union, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { n as ZodIssueCode } from "./compat-bCpUj7Jq.js";
import { C as SecretInputSchema, L as requireAllowlistAllowFrom, R as requireOpenAllowFrom, S as RetryConfigSchema, T as SecretRefSchema, a as DmConfigSchema, h as MarkdownConfigSchema, i as ContextVisibilityModeSchema, j as TtsConfigSchema, l as GroupPolicySchema, m as MSTeamsReplyStyleSchema, n as BlockStreamingCoalesceSchema, o as DmPolicySchema, s as ExecutableTokenSchema, t as BlockStreamingChunkSchema, u as HexColorSchema, v as ProviderCommandsSchema, x as ReplyToModeSchema } from "./zod-schema.core-D7Y_eqdd.js";
import { t as sensitive } from "./zod-schema.sensitive-3GVmnUbm.js";
import { u as ToolPolicySchema } from "./zod-schema.agent-runtime-Bq5CXVVg.js";
import { i as NativeExecApprovalEnableModeSchema, n as ChannelHeartbeatVisibilitySchema, t as ChannelHealthMonitorSchema } from "./zod-schema.channels-BJfpHgPH.js";
import "./config-schema-ChfiQrSg.js";
import { t as resolveAccountEntry } from "./account-lookup-CQEoGO1F.js";
import { n as isValidInboundPathRootPattern } from "./inbound-path-policy-DEbcUBWg.js";
import { n as normalizeSlashCommandName, r as resolveCustomCommands, t as normalizeCommandDescription } from "./custom-command-config-BbzXN2DE.js";
import { t as isSafeScpRemoteHost } from "./scp-host-CIH1Vnml.js";
//#region src/config/zod-schema.secret-input-validation.ts
function forEachEnabledAccount(accounts, run) {
	if (!accounts) return;
	for (const [accountId, account] of Object.entries(accounts)) {
		if (!account || account.enabled === false) continue;
		run(accountId, account);
	}
}
function validateTelegramWebhookSecretRequirements(value, ctx) {
	const baseWebhookUrl = normalizeOptionalString(value.webhookUrl) ?? "";
	const hasBaseWebhookSecret = hasConfiguredSecretInput(value.webhookSecret);
	if (baseWebhookUrl && !hasBaseWebhookSecret) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
		path: ["webhookSecret"]
	});
	forEachEnabledAccount(value.accounts, (accountId, account) => {
		if (!(normalizeOptionalString(account.webhookUrl) ?? "")) return;
		if (!hasConfiguredSecretInput(account.webhookSecret) && !hasBaseWebhookSecret) ctx.addIssue({
			code: ZodIssueCode.custom,
			message: "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
			path: [
				"accounts",
				accountId,
				"webhookSecret"
			]
		});
	});
}
function validateSlackSigningSecretRequirements(value, ctx) {
	const baseMode = value.mode === "http" || value.mode === "socket" ? value.mode : "socket";
	if (baseMode === "http" && !hasConfiguredSecretInput(value.signingSecret)) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "channels.slack.mode=\"http\" requires channels.slack.signingSecret",
		path: ["signingSecret"]
	});
	forEachEnabledAccount(value.accounts, (accountId, account) => {
		if ((account.mode === "http" || account.mode === "socket" ? account.mode : baseMode) !== "http") return;
		if (!hasConfiguredSecretInput(account.signingSecret ?? value.signingSecret)) ctx.addIssue({
			code: ZodIssueCode.custom,
			message: "channels.slack.accounts.*.mode=\"http\" requires channels.slack.signingSecret or channels.slack.accounts.*.signingSecret",
			path: [
				"accounts",
				accountId,
				"signingSecret"
			]
		});
	});
}
//#endregion
//#region src/config/zod-schema.providers-core.ts
const ToolPolicyBySenderSchema$1 = record(string(), ToolPolicySchema).optional();
const DiscordIdSchema = union([string(), number()]).transform((value, ctx) => {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value < 0) {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				message: `Discord ID "${String(value)}" is not a valid non-negative safe integer. Wrap it in quotes in your config file.`
			});
			return NEVER;
		}
		return String(value);
	}
	return value;
}).pipe(string());
const DiscordIdListSchema = array(DiscordIdSchema);
const DiscordSnowflakeStringSchema = string().regex(/^\d+$/, "Discord user ID must be numeric");
const TelegramInlineButtonsScopeSchema = _enum([
	"off",
	"dm",
	"group",
	"all",
	"allowlist"
]);
const TelegramIdListSchema = array(union([string(), number()]));
const TelegramCapabilitiesSchema = union([array(string()), object({ inlineButtons: TelegramInlineButtonsScopeSchema.optional() }).strict()]);
const TextChunkModeSchema = _enum(["length", "newline"]);
const UnifiedStreamingModeSchema = _enum([
	"off",
	"partial",
	"block",
	"progress"
]);
const ChannelStreamingBlockSchema = object({
	enabled: boolean().optional(),
	coalesce: BlockStreamingCoalesceSchema.optional()
}).strict();
const ChannelStreamingPreviewSchema = object({
	chunk: BlockStreamingChunkSchema.optional(),
	toolProgress: boolean().optional(),
	commandText: _enum(["raw", "status"]).optional()
}).strict();
const TelegramStreamingPreviewSchema = ChannelStreamingPreviewSchema.extend({
	nativeToolProgress: boolean().optional(),
	nativeToolProgressAllowFrom: array(union([string(), number()])).optional()
}).strict();
const ChannelStreamingProgressSchema = object({
	label: union([string(), literal(false)]).optional(),
	labels: array(string()).optional(),
	maxLines: number().int().positive().optional(),
	maxLineChars: number().int().positive().optional(),
	render: _enum(["text", "rich"]).optional(),
	toolProgress: boolean().optional(),
	commandText: _enum(["raw", "status"]).optional()
}).strict();
const ChannelPreviewStreamingConfigSchema = object({
	mode: UnifiedStreamingModeSchema.optional(),
	chunkMode: TextChunkModeSchema.optional(),
	preview: ChannelStreamingPreviewSchema.optional(),
	progress: ChannelStreamingProgressSchema.optional(),
	block: ChannelStreamingBlockSchema.optional()
}).strict();
const TelegramPreviewStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({ preview: TelegramStreamingPreviewSchema.optional() }).strict();
const SlackStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({ nativeTransport: boolean().optional() }).strict();
const SlackCapabilitiesSchema = union([array(string()), object({ interactiveReplies: boolean().optional() }).strict()]);
const BotLoopProtectionSchema = object({
	enabled: boolean().optional(),
	maxEventsPerWindow: number().int().positive().optional(),
	windowSeconds: number().int().positive().optional(),
	cooldownSeconds: number().int().positive().optional()
}).strict();
const TelegramErrorPolicySchema = _enum([
	"always",
	"once",
	"silent"
]).optional();
const TelegramCustomCommandConfig = {
	label: "Telegram",
	pattern: /^[a-z0-9_]{1,32}$/,
	patternDescription: "use a-z, 0-9, underscore; max 32 chars"
};
const TelegramTopicSchema = object({
	requireMention: boolean().optional(),
	ingest: boolean().optional(),
	disableAudioPreflight: boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	skills: array(string()).optional(),
	enabled: boolean().optional(),
	allowFrom: array(union([string(), number()])).optional(),
	systemPrompt: string().optional(),
	agentId: string().optional(),
	errorPolicy: TelegramErrorPolicySchema,
	errorCooldownMs: number().int().nonnegative().optional()
}).strict();
const TelegramGroupSchema = object({
	requireMention: boolean().optional(),
	ingest: boolean().optional(),
	disableAudioPreflight: boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: array(string()).optional(),
	enabled: boolean().optional(),
	allowFrom: array(union([string(), number()])).optional(),
	systemPrompt: string().optional(),
	topics: record(string(), TelegramTopicSchema.optional()).optional(),
	errorPolicy: TelegramErrorPolicySchema,
	errorCooldownMs: number().int().nonnegative().optional()
}).strict();
const TelegramDmSchema = object({ threadReplies: _enum([
	"off",
	"inbound",
	"always"
]).optional() }).strict();
const AutoTopicLabelSchema = union([boolean(), object({
	enabled: boolean().optional(),
	prompt: string().optional()
}).strict()]).optional();
const TelegramDirectSchema = object({
	dmPolicy: DmPolicySchema.optional(),
	threadReplies: _enum([
		"off",
		"inbound",
		"always"
	]).optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: array(string()).optional(),
	enabled: boolean().optional(),
	allowFrom: array(union([string(), number()])).optional(),
	systemPrompt: string().optional(),
	topics: record(string(), TelegramTopicSchema.optional()).optional(),
	errorPolicy: TelegramErrorPolicySchema,
	errorCooldownMs: number().int().nonnegative().optional(),
	requireTopic: boolean().optional(),
	autoTopicLabel: AutoTopicLabelSchema
}).strict();
const TelegramCustomCommandSchema = object({
	command: string().overwrite(normalizeSlashCommandName),
	description: string().overwrite(normalizeCommandDescription)
}).strict();
const validateTelegramCustomCommands = (value, ctx) => {
	if (!value.customCommands || value.customCommands.length === 0) return;
	const { issues } = resolveCustomCommands({
		commands: value.customCommands,
		checkReserved: false,
		checkDuplicates: false,
		config: TelegramCustomCommandConfig
	});
	for (const issue of issues) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: [
			"customCommands",
			issue.index,
			issue.field
		],
		message: issue.message
	});
};
const TelegramAccountSchemaBase = object({
	name: string().optional(),
	capabilities: TelegramCapabilitiesSchema.optional(),
	execApprovals: object({
		enabled: NativeExecApprovalEnableModeSchema.optional(),
		approvers: TelegramIdListSchema.optional(),
		agentFilter: array(string()).optional(),
		sessionFilter: array(string()).optional(),
		target: _enum([
			"dm",
			"channel",
			"both"
		]).optional()
	}).strict().optional(),
	markdown: MarkdownConfigSchema,
	enabled: boolean().optional(),
	commands: ProviderCommandsSchema,
	customCommands: array(TelegramCustomCommandSchema).optional(),
	configWrites: boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	botToken: SecretInputSchema.optional().register(sensitive),
	tokenFile: string().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	dm: TelegramDmSchema.optional(),
	groups: record(string(), TelegramGroupSchema.optional()).optional(),
	allowFrom: array(union([string(), number()])).optional(),
	defaultTo: union([string(), number()]).optional(),
	groupAllowFrom: array(union([string(), number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	dms: record(string(), DmConfigSchema.optional()).optional(),
	direct: record(string(), TelegramDirectSchema.optional()).optional(),
	textChunkLimit: number().int().positive().optional(),
	streaming: TelegramPreviewStreamingConfigSchema.optional(),
	mediaMaxMb: number().positive().optional(),
	timeoutSeconds: number().int().positive().optional(),
	mediaGroupFlushMs: number().int().min(10).max(6e4).optional().describe("Buffer window in milliseconds for Telegram media groups/albums before dispatching them as one inbound message. Default: 500."),
	pollingStallThresholdMs: number().int().min(3e4).max(6e5).optional(),
	retry: RetryConfigSchema,
	network: object({
		autoSelectFamily: boolean().optional(),
		dnsResultOrder: _enum(["ipv4first", "verbatim"]).optional(),
		dangerouslyAllowPrivateNetwork: boolean().optional().describe("Dangerous opt-in for trusted Telegram fake-IP or transparent-proxy environments where api.telegram.org resolves to private/internal/special-use addresses during media downloads.")
	}).strict().optional(),
	proxy: string().optional(),
	webhookUrl: string().optional().describe("Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret."),
	webhookSecret: SecretInputSchema.optional().describe("Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.").register(sensitive),
	webhookPath: string().optional().describe("Local webhook route path served by the gateway listener. Defaults to /telegram-webhook."),
	webhookHost: string().optional().describe("Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress."),
	webhookPort: number().int().nonnegative().optional().describe("Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port."),
	webhookCertPath: string().optional().describe("Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. Required for self-signed certs (direct IP or no domain)."),
	actions: object({
		reactions: boolean().optional(),
		sendMessage: boolean().optional(),
		poll: boolean().optional(),
		deleteMessage: boolean().optional(),
		editMessage: boolean().optional(),
		sticker: boolean().optional(),
		createForumTopic: boolean().optional(),
		editForumTopic: boolean().optional()
	}).strict().optional(),
	threadBindings: object({
		enabled: boolean().optional(),
		idleHours: number().nonnegative().optional(),
		maxAgeHours: number().nonnegative().optional(),
		spawnSessions: boolean().optional(),
		defaultSpawnContext: _enum(["isolated", "fork"]).optional(),
		spawnSubagentSessions: boolean().optional(),
		spawnAcpSessions: boolean().optional()
	}).strict().optional(),
	reactionNotifications: _enum([
		"off",
		"own",
		"all"
	]).optional(),
	reactionLevel: _enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	linkPreview: boolean().optional(),
	silentErrorReplies: boolean().optional(),
	responsePrefix: string().optional(),
	ackReaction: string().optional(),
	errorPolicy: TelegramErrorPolicySchema,
	errorCooldownMs: number().int().nonnegative().optional(),
	apiRoot: string().url().optional(),
	trustedLocalFileRoots: array(string()).optional().describe("Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths under these roots are read directly; all other absolute paths are rejected."),
	autoTopicLabel: AutoTopicLabelSchema
}).strict();
const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
	validateTelegramCustomCommands(value, ctx);
});
const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
	accounts: record(string(), TelegramAccountSchema.optional()).optional(),
	defaultAccount: string().optional()
}).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.telegram.dmPolicy=\"open\" requires channels.telegram.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.telegram.dmPolicy=\"allowlist\" requires channels.telegram.allowFrom to contain at least one sender ID"
	});
	validateTelegramCustomCommands(value, ctx);
	if (value.accounts) for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"open\" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"allowlist\" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to contain at least one sender ID"
		});
	}
	if (!value.accounts) {
		validateTelegramWebhookSecretRequirements(value, ctx);
		return;
	}
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		if (account.enabled === false) continue;
		const effectiveDmPolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = Array.isArray(account.allowFrom) ? account.allowFrom : value.allowFrom;
		requireOpenAllowFrom({
			policy: effectiveDmPolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"open\" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectiveDmPolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"allowlist\" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to contain at least one sender ID"
		});
	}
	validateTelegramWebhookSecretRequirements(value, ctx);
});
const DiscordDmSchema = object({
	enabled: boolean().optional(),
	policy: DmPolicySchema.optional(),
	allowFrom: DiscordIdListSchema.optional(),
	groupEnabled: boolean().optional(),
	groupChannels: DiscordIdListSchema.optional()
}).strict();
const DiscordThreadSchema = object({ inheritParent: boolean().optional() }).strict();
const DiscordGuildChannelSchema = object({
	requireMention: boolean().optional(),
	ignoreOtherMentions: boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: array(string()).optional(),
	enabled: boolean().optional(),
	users: DiscordIdListSchema.optional(),
	roles: DiscordIdListSchema.optional(),
	systemPrompt: string().optional(),
	includeThreadStarter: boolean().optional(),
	autoThread: boolean().optional(),
	/** Naming strategy for auto-created threads. "message" uses message text; "generated" creates an LLM title after thread creation. */
	autoThreadName: _enum(["message", "generated"]).optional(),
	/** Archive duration for auto-created threads in minutes. Discord supports 60, 1440 (1 day), 4320 (3 days), 10080 (1 week). Default: 60. */
	autoArchiveDuration: union([
		_enum([
			"60",
			"1440",
			"4320",
			"10080"
		]),
		literal(60),
		literal(1440),
		literal(4320),
		literal(10080)
	]).optional()
}).strict();
const DiscordGuildSchema = object({
	slug: string().optional(),
	requireMention: boolean().optional(),
	ignoreOtherMentions: boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	reactionNotifications: _enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	users: DiscordIdListSchema.optional(),
	roles: DiscordIdListSchema.optional(),
	channels: record(string(), DiscordGuildChannelSchema.optional()).optional()
}).strict();
const DiscordUiSchema = object({ components: object({ accentColor: HexColorSchema.optional() }).strict().optional() }).strict().optional();
const DiscordVoiceAutoJoinSchema = object({
	guildId: string().min(1),
	channelId: string().min(1)
}).strict();
const DiscordVoiceAllowedChannelSchema = object({
	guildId: string().min(1),
	channelId: string().min(1)
}).strict();
const DiscordVoiceRealtimeToolPolicySchema = _enum([
	"safe-read-only",
	"owner",
	"none"
]);
const DiscordVoiceRealtimeConsultPolicySchema = _enum(["auto", "always"]);
const DiscordVoiceRealtimeBootstrapContextFileSchema = _enum([
	"IDENTITY.md",
	"USER.md",
	"SOUL.md"
]);
const DiscordVoiceRealtimeSchema = object({
	provider: string().min(1).optional(),
	model: string().min(1).optional(),
	voice: string().min(1).optional(),
	instructions: string().min(1).optional(),
	toolPolicy: DiscordVoiceRealtimeToolPolicySchema.optional(),
	consultPolicy: DiscordVoiceRealtimeConsultPolicySchema.optional(),
	bootstrapContextFiles: array(DiscordVoiceRealtimeBootstrapContextFileSchema).optional(),
	bargeIn: boolean().optional(),
	minBargeInAudioEndMs: number().int().min(0).max(1e4).optional(),
	debounceMs: number().int().positive().max(1e4).optional(),
	providers: record(string(), record(string(), unknown()).optional()).optional()
}).strict();
const DiscordVoiceAgentSessionSchema = object({
	mode: _enum(["voice", "target"]).optional(),
	target: string().min(1).optional()
}).strict().superRefine((value, ctx) => {
	if (value.mode === "target" && !value.target) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["target"],
		message: "voice.agentSession.target is required when mode is \"target\""
	});
});
const DiscordVoiceSchema = object({
	enabled: boolean().optional(),
	mode: _enum([
		"stt-tts",
		"agent-proxy",
		"bidi"
	]).optional(),
	agentSession: DiscordVoiceAgentSessionSchema.optional(),
	model: string().min(1).optional(),
	realtime: DiscordVoiceRealtimeSchema.optional(),
	autoJoin: array(DiscordVoiceAutoJoinSchema).optional(),
	followUsersEnabled: boolean().optional(),
	followUsers: array(string().min(1)).optional(),
	allowedChannels: array(DiscordVoiceAllowedChannelSchema).optional(),
	daveEncryption: boolean().optional(),
	decryptionFailureTolerance: number().int().min(0).optional(),
	connectTimeoutMs: number().int().positive().max(12e4).optional(),
	reconnectGraceMs: number().int().positive().max(12e4).optional(),
	captureSilenceGraceMs: number().int().positive().max(3e4).optional(),
	tts: TtsConfigSchema.optional()
}).strict().optional();
const DiscordAccountSchema = object({
	name: string().optional(),
	capabilities: array(string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: boolean().optional(),
	token: SecretInputSchema.optional().register(sensitive),
	applicationId: DiscordIdSchema.optional(),
	proxy: string().optional(),
	gatewayInfoTimeoutMs: number().int().positive().max(12e4).optional(),
	gatewayReadyTimeoutMs: number().int().positive().max(12e4).optional(),
	gatewayRuntimeReadyTimeoutMs: number().int().positive().max(12e4).optional(),
	allowBots: union([boolean(), literal("mentions")]).optional(),
	botLoopProtection: BotLoopProtectionSchema.optional(),
	dangerouslyAllowNameMatching: boolean().optional(),
	mentionAliases: record(string(), DiscordSnowflakeStringSchema).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	dms: record(string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: number().int().positive().optional(),
	suppressEmbeds: boolean().optional(),
	streaming: ChannelPreviewStreamingConfigSchema.optional(),
	maxLinesPerMessage: number().int().positive().optional(),
	mediaMaxMb: number().positive().optional(),
	retry: RetryConfigSchema,
	actions: object({
		reactions: boolean().optional(),
		stickers: boolean().optional(),
		emojiUploads: boolean().optional(),
		stickerUploads: boolean().optional(),
		polls: boolean().optional(),
		permissions: boolean().optional(),
		messages: boolean().optional(),
		threads: boolean().optional(),
		pins: boolean().optional(),
		search: boolean().optional(),
		memberInfo: boolean().optional(),
		roleInfo: boolean().optional(),
		roles: boolean().optional(),
		channelInfo: boolean().optional(),
		voiceStatus: boolean().optional(),
		events: boolean().optional(),
		moderation: boolean().optional(),
		channels: boolean().optional(),
		presence: boolean().optional()
	}).strict().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	thread: DiscordThreadSchema.optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: DiscordIdListSchema.optional(),
	defaultTo: string().optional(),
	dm: DiscordDmSchema.optional(),
	guilds: record(string(), DiscordGuildSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	execApprovals: object({
		enabled: NativeExecApprovalEnableModeSchema.optional(),
		approvers: DiscordIdListSchema.optional(),
		agentFilter: array(string()).optional(),
		sessionFilter: array(string()).optional(),
		cleanupAfterResolve: boolean().optional(),
		target: _enum([
			"dm",
			"channel",
			"both"
		]).optional()
	}).strict().optional(),
	agentComponents: object({
		enabled: boolean().optional(),
		ttlMs: number().int().positive().max(1440 * 60 * 1e3).optional()
	}).strict().optional(),
	ui: DiscordUiSchema,
	slashCommand: object({ ephemeral: boolean().optional() }).strict().optional(),
	threadBindings: object({
		enabled: boolean().optional(),
		idleHours: number().nonnegative().optional(),
		maxAgeHours: number().nonnegative().optional(),
		spawnSessions: boolean().optional(),
		defaultSpawnContext: _enum(["isolated", "fork"]).optional(),
		spawnSubagentSessions: boolean().optional(),
		spawnAcpSessions: boolean().optional()
	}).strict().optional(),
	intents: object({
		presence: boolean().optional(),
		guildMembers: boolean().optional(),
		voiceStates: boolean().optional()
	}).strict().optional(),
	voice: DiscordVoiceSchema,
	pluralkit: object({
		enabled: boolean().optional(),
		token: SecretInputSchema.optional().register(sensitive)
	}).strict().optional(),
	responsePrefix: string().optional(),
	ackReaction: string().optional(),
	ackReactionScope: _enum([
		"group-mentions",
		"group-all",
		"direct",
		"all",
		"off",
		"none"
	]).optional(),
	activity: string().optional(),
	status: _enum([
		"online",
		"dnd",
		"idle",
		"invisible"
	]).optional(),
	autoPresence: object({
		enabled: boolean().optional(),
		intervalMs: number().int().positive().optional(),
		minUpdateIntervalMs: number().int().positive().optional(),
		healthyText: string().optional(),
		degradedText: string().optional(),
		exhaustedText: string().optional()
	}).strict().optional(),
	activityType: union([
		literal(0),
		literal(1),
		literal(2),
		literal(3),
		literal(4),
		literal(5)
	]).optional(),
	activityUrl: string().url().optional(),
	inboundWorker: object({ runTimeoutMs: number().int().nonnegative().optional() }).strict().optional(),
	eventQueue: object({
		listenerTimeout: number().int().positive().optional(),
		maxQueueSize: number().int().positive().optional(),
		maxConcurrency: number().int().positive().optional()
	}).strict().optional()
}).strict().superRefine((value, ctx) => {
	const activityText = normalizeOptionalString(value.activity) ?? "";
	const hasActivity = Boolean(activityText);
	const hasActivityType = value.activityType !== void 0;
	const activityUrl = normalizeOptionalString(value.activityUrl) ?? "";
	const hasActivityUrl = Boolean(activityUrl);
	if ((hasActivityType || hasActivityUrl) && !hasActivity) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "channels.discord.activity is required when activityType or activityUrl is set",
		path: ["activity"]
	});
	if (value.activityType === 1 && !hasActivityUrl) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "channels.discord.activityUrl is required when activityType is 1 (Streaming)",
		path: ["activityUrl"]
	});
	if (hasActivityUrl && value.activityType !== 1) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "channels.discord.activityType must be 1 (Streaming) when activityUrl is set",
		path: ["activityType"]
	});
	const autoPresenceInterval = value.autoPresence?.intervalMs;
	const autoPresenceMinUpdate = value.autoPresence?.minUpdateIntervalMs;
	if (typeof autoPresenceInterval === "number" && typeof autoPresenceMinUpdate === "number" && autoPresenceMinUpdate > autoPresenceInterval) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "channels.discord.autoPresence.minUpdateIntervalMs must be less than or equal to channels.discord.autoPresence.intervalMs",
		path: ["autoPresence", "minUpdateIntervalMs"]
	});
});
const DiscordConfigSchema = DiscordAccountSchema.extend({
	accounts: record(string(), DiscordAccountSchema.optional()).optional(),
	defaultAccount: string().optional()
}).superRefine((value, ctx) => {
	const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
	const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
	const allowFromPath = value.allowFrom !== void 0 ? ["allowFrom"] : ["dm", "allowFrom"];
	requireOpenAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.discord.dmPolicy=\"open\" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.discord.dmPolicy=\"allowlist\" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to contain at least one sender ID"
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
		const effectiveAllowFrom = account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.discord.accounts.*.dmPolicy=\"open\" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.discord.accounts.*.dmPolicy=\"allowlist\" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to contain at least one sender ID"
		});
	}
});
const GoogleChatDmSchema = object({
	enabled: boolean().optional(),
	policy: DmPolicySchema.optional().default("pairing"),
	allowFrom: array(union([string(), number()])).optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.policy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.googlechat.dm.policy=\"open\" requires channels.googlechat.dm.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.policy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.googlechat.dm.policy=\"allowlist\" requires channels.googlechat.dm.allowFrom to contain at least one sender ID"
	});
});
const GoogleChatGroupSchema = object({
	enabled: boolean().optional(),
	requireMention: boolean().optional(),
	botLoopProtection: BotLoopProtectionSchema.optional(),
	users: array(union([string(), number()])).optional(),
	systemPrompt: string().optional()
}).strict();
const GoogleChatAccountSchema = object({
	name: string().optional(),
	capabilities: array(string()).optional(),
	enabled: boolean().optional(),
	configWrites: boolean().optional(),
	allowBots: boolean().optional(),
	botLoopProtection: BotLoopProtectionSchema.optional(),
	dangerouslyAllowNameMatching: boolean().optional(),
	requireMention: boolean().optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groupAllowFrom: array(union([string(), number()])).optional(),
	groups: record(string(), GoogleChatGroupSchema.optional()).optional(),
	defaultTo: string().optional(),
	serviceAccount: union([
		string(),
		record(string(), unknown()),
		SecretRefSchema
	]).optional().register(sensitive),
	serviceAccountRef: SecretRefSchema.optional().register(sensitive),
	serviceAccountFile: string().optional(),
	audienceType: _enum(["app-url", "project-number"]).optional(),
	audience: string().optional(),
	appPrincipal: string().optional(),
	webhookPath: string().optional(),
	webhookUrl: string().optional(),
	botUser: string().optional(),
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	dms: record(string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: number().int().positive().optional(),
	chunkMode: _enum(["length", "newline"]).optional(),
	blockStreaming: boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: number().positive().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	actions: object({ reactions: boolean().optional() }).strict().optional(),
	dm: GoogleChatDmSchema.optional(),
	healthMonitor: ChannelHealthMonitorSchema,
	typingIndicator: _enum([
		"none",
		"message",
		"reaction"
	]).optional(),
	responsePrefix: string().optional()
}).strict();
const GoogleChatConfigSchema = GoogleChatAccountSchema.extend({
	accounts: record(string(), GoogleChatAccountSchema.optional()).optional(),
	defaultAccount: string().optional()
});
const SlackDmSchema = object({
	enabled: boolean().optional(),
	policy: DmPolicySchema.optional(),
	allowFrom: array(union([string(), number()])).optional(),
	groupEnabled: boolean().optional(),
	groupChannels: array(union([string(), number()])).optional(),
	replyToMode: ReplyToModeSchema.optional()
}).strict();
const SlackChannelSchema = object({
	enabled: boolean().optional(),
	requireMention: boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	allowBots: union([boolean(), literal("mentions")]).optional(),
	botLoopProtection: BotLoopProtectionSchema.optional(),
	users: array(union([string(), number()])).optional(),
	skills: array(string()).optional(),
	systemPrompt: string().optional()
}).strict();
const SlackThreadSchema = object({
	historyScope: _enum(["thread", "channel"]).optional(),
	inheritParent: boolean().optional(),
	initialHistoryLimit: number().int().min(0).optional(),
	requireExplicitMention: boolean().optional()
}).strict();
const SlackReplyToModeByChatTypeSchema = object({
	direct: ReplyToModeSchema.optional(),
	group: ReplyToModeSchema.optional(),
	channel: ReplyToModeSchema.optional()
}).strict();
const SlackSocketModeSchema = object({
	clientPingTimeout: number().int().positive().optional(),
	serverPingTimeout: number().int().positive().optional(),
	pingPongLoggingEnabled: boolean().optional()
}).strict();
const SlackAccountSchema = object({
	name: string().optional(),
	mode: _enum(["socket", "http"]).optional(),
	socketMode: SlackSocketModeSchema.optional(),
	signingSecret: SecretInputSchema.optional().register(sensitive),
	webhookPath: string().optional(),
	capabilities: SlackCapabilitiesSchema.optional(),
	execApprovals: object({
		enabled: NativeExecApprovalEnableModeSchema.optional(),
		approvers: array(union([string(), number()])).optional(),
		agentFilter: array(string()).optional(),
		sessionFilter: array(string()).optional(),
		target: _enum([
			"dm",
			"channel",
			"both"
		]).optional()
	}).strict().optional(),
	markdown: MarkdownConfigSchema,
	enabled: boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: boolean().optional(),
	botToken: SecretInputSchema.optional().register(sensitive),
	appToken: SecretInputSchema.optional().register(sensitive),
	userToken: SecretInputSchema.optional().register(sensitive),
	userTokenReadOnly: boolean().optional().default(true),
	allowBots: union([boolean(), literal("mentions")]).optional(),
	botLoopProtection: BotLoopProtectionSchema.optional(),
	dangerouslyAllowNameMatching: boolean().optional(),
	requireMention: boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	dms: record(string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: number().int().positive().optional(),
	unfurlLinks: boolean().optional(),
	unfurlMedia: boolean().optional(),
	streaming: SlackStreamingConfigSchema.optional(),
	mediaMaxMb: number().positive().optional(),
	reactionNotifications: _enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: array(union([string(), number()])).optional(),
	replyToMode: ReplyToModeSchema.optional(),
	replyToModeByChatType: SlackReplyToModeByChatTypeSchema.optional(),
	thread: SlackThreadSchema.optional(),
	actions: object({
		reactions: boolean().optional(),
		messages: boolean().optional(),
		pins: boolean().optional(),
		search: boolean().optional(),
		permissions: boolean().optional(),
		memberInfo: boolean().optional(),
		channelInfo: boolean().optional(),
		emojiList: boolean().optional()
	}).strict().optional(),
	slashCommand: object({
		enabled: boolean().optional(),
		name: string().optional(),
		sessionPrefix: string().optional(),
		ephemeral: boolean().optional()
	}).strict().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: array(union([string(), number()])).optional(),
	defaultTo: string().optional(),
	dm: SlackDmSchema.optional(),
	channels: record(string(), SlackChannelSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: string().optional(),
	ackReaction: string().optional(),
	typingReaction: string().optional()
}).strict().superRefine(() => {});
const SlackConfigSchema = SlackAccountSchema.safeExtend({
	mode: _enum(["socket", "http"]).optional().default("socket"),
	signingSecret: SecretInputSchema.optional().register(sensitive),
	webhookPath: string().optional().default("/slack/events"),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	accounts: record(string(), SlackAccountSchema.optional()).optional(),
	defaultAccount: string().optional()
}).superRefine((value, ctx) => {
	const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
	const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
	const allowFromPath = value.allowFrom !== void 0 ? ["allowFrom"] : ["dm", "allowFrom"];
	requireOpenAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.slack.dmPolicy=\"open\" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.slack.dmPolicy=\"allowlist\" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to contain at least one sender ID"
	});
	const baseMode = value.mode ?? "socket";
	if (!value.accounts) {
		validateSlackSigningSecretRequirements(value, ctx);
		return;
	}
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		if (account.enabled === false) continue;
		const accountMode = account.mode ?? baseMode;
		const effectivePolicy = account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
		const effectiveAllowFrom = account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.slack.accounts.*.dmPolicy=\"open\" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.slack.accounts.*.dmPolicy=\"allowlist\" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to contain at least one sender ID"
		});
		if (accountMode !== "http") continue;
	}
	validateSlackSigningSecretRequirements(value, ctx);
});
const SignalGroupEntrySchema = object({
	requireMention: boolean().optional(),
	ingest: boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1
}).strict();
const SignalGroupsSchema = record(string(), SignalGroupEntrySchema.optional()).optional();
const SignalAccountSchemaBase = object({
	name: string().optional(),
	capabilities: array(string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: boolean().optional(),
	configWrites: boolean().optional(),
	account: string().optional(),
	accountUuid: string().optional(),
	httpUrl: string().optional(),
	httpHost: string().optional(),
	httpPort: number().int().positive().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	autoStart: boolean().optional(),
	startupTimeoutMs: number().int().min(1e3).max(12e4).optional(),
	receiveMode: union([literal("on-start"), literal("manual")]).optional(),
	ignoreAttachments: boolean().optional(),
	ignoreStories: boolean().optional(),
	sendReadReceipts: boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: array(union([string(), number()])).optional(),
	defaultTo: string().optional(),
	groupAllowFrom: array(union([string(), number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	groups: SignalGroupsSchema,
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	dms: record(string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: number().int().positive().optional(),
	chunkMode: _enum(["length", "newline"]).optional(),
	blockStreaming: boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: number().int().positive().optional(),
	reactionNotifications: _enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: array(union([string(), number()])).optional(),
	actions: object({ reactions: boolean().optional() }).strict().optional(),
	reactionLevel: _enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: string().optional()
}).strict();
const SignalAccountSchema = SignalAccountSchemaBase;
const SignalConfigSchema = SignalAccountSchemaBase.extend({
	apiMode: _enum([
		"auto",
		"native",
		"container"
	]).optional(),
	accounts: record(string(), SignalAccountSchema.optional()).optional(),
	defaultAccount: string().optional()
}).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.signal.dmPolicy=\"open\" requires channels.signal.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.signal.dmPolicy=\"allowlist\" requires channels.signal.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.signal.accounts.*.dmPolicy=\"open\" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.signal.accounts.*.dmPolicy=\"allowlist\" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to contain at least one sender ID"
		});
	}
});
const IrcGroupSchema = object({
	requireMention: boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: array(string()).optional(),
	enabled: boolean().optional(),
	allowFrom: array(union([string(), number()])).optional(),
	systemPrompt: string().optional()
}).strict();
const IrcNickServSchema = object({
	enabled: boolean().optional(),
	service: string().optional(),
	password: SecretInputSchema.optional().register(sensitive),
	passwordFile: string().optional(),
	register: boolean().optional(),
	registerEmail: string().optional()
}).strict();
const IrcAccountSchemaBase = object({
	name: string().optional(),
	capabilities: array(string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: boolean().optional(),
	configWrites: boolean().optional(),
	host: string().optional(),
	port: number().int().min(1).max(65535).optional(),
	tls: boolean().optional(),
	nick: string().optional(),
	username: string().optional(),
	realname: string().optional(),
	password: SecretInputSchema.optional().register(sensitive),
	passwordFile: string().optional(),
	nickserv: IrcNickServSchema.optional(),
	channels: array(string()).optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: array(union([string(), number()])).optional(),
	defaultTo: string().optional(),
	groupAllowFrom: array(union([string(), number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	groups: record(string(), IrcGroupSchema.optional()).optional(),
	mentionPatterns: array(string()).optional(),
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	dms: record(string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: number().int().positive().optional(),
	chunkMode: _enum(["length", "newline"]).optional(),
	blockStreaming: boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: number().positive().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: string().optional()
}).strict();
function refineIrcAllowFromAndNickserv(value, ctx) {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"open\" requires channels.irc.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"allowlist\" requires channels.irc.allowFrom to contain at least one sender ID"
	});
	if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
}
const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
	if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
});
IrcAccountSchemaBase.extend({
	accounts: record(string(), IrcAccountSchema.optional()).optional(),
	defaultAccount: string().optional()
}).superRefine((value, ctx) => {
	refineIrcAllowFromAndNickserv(value, ctx);
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.irc.accounts.*.dmPolicy=\"open\" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.irc.accounts.*.dmPolicy=\"allowlist\" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to contain at least one sender ID"
		});
	}
});
const IMessageActionSchema = object({
	reactions: boolean().optional(),
	edit: boolean().optional(),
	unsend: boolean().optional(),
	reply: boolean().optional(),
	sendWithEffect: boolean().optional(),
	renameGroup: boolean().optional(),
	setGroupIcon: boolean().optional(),
	addParticipant: boolean().optional(),
	removeParticipant: boolean().optional(),
	leaveGroup: boolean().optional(),
	sendAttachment: boolean().optional()
}).strict().optional();
const IMessageAccountSchemaBase = object({
	name: string().optional(),
	capabilities: array(string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: boolean().optional(),
	configWrites: boolean().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	dbPath: string().optional(),
	remoteHost: string().refine(isSafeScpRemoteHost, "expected SSH host or user@host (no spaces/options)").optional(),
	actions: IMessageActionSchema,
	service: union([
		literal("imessage"),
		literal("sms"),
		literal("auto")
	]).optional(),
	region: string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: array(union([string(), number()])).optional(),
	defaultTo: string().optional(),
	groupAllowFrom: array(union([string(), number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	dms: record(string(), DmConfigSchema.optional()).optional(),
	includeAttachments: boolean().optional(),
	attachmentRoots: array(string().refine(isValidInboundPathRootPattern, "expected absolute path root")).optional(),
	remoteAttachmentRoots: array(string().refine(isValidInboundPathRootPattern, "expected absolute path root")).optional(),
	mediaMaxMb: number().int().positive().optional(),
	probeTimeoutMs: number().int().positive().optional(),
	textChunkLimit: number().int().positive().optional(),
	chunkMode: _enum(["length", "newline"]).optional(),
	blockStreaming: boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	sendReadReceipts: boolean().optional(),
	reactionNotifications: _enum([
		"off",
		"own",
		"all"
	]).optional(),
	coalesceSameSenderDms: boolean().optional(),
	groups: record(string(), object({
		requireMention: boolean().optional(),
		tools: ToolPolicySchema,
		toolsBySender: ToolPolicyBySenderSchema$1,
		systemPrompt: string().optional()
	}).strict().optional()).optional(),
	catchup: object({
		enabled: boolean().optional(),
		maxAgeMinutes: number().int().min(1).max(720).optional(),
		perRunLimit: number().int().min(1).max(500).optional(),
		firstRunLookbackMinutes: number().int().min(1).max(720).optional(),
		maxFailureRetries: number().int().min(1).max(1e3).optional()
	}).strict().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: string().optional()
}).strict();
const IMessageAccountSchema = IMessageAccountSchemaBase;
const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
	accounts: record(string(), IMessageAccountSchema.optional()).optional(),
	defaultAccount: string().optional()
}).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.imessage.dmPolicy=\"open\" requires channels.imessage.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.imessage.dmPolicy=\"allowlist\" requires channels.imessage.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.imessage.accounts.*.dmPolicy=\"open\" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.imessage.accounts.*.dmPolicy=\"allowlist\" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to contain at least one sender ID"
		});
	}
});
const MSTeamsChannelSchema = object({
	requireMention: boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	replyStyle: MSTeamsReplyStyleSchema.optional()
}).strict();
const MSTeamsTeamSchema = object({
	requireMention: boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	channels: record(string(), MSTeamsChannelSchema.optional()).optional()
}).strict();
const MSTeamsConfigSchema = object({
	enabled: boolean().optional(),
	capabilities: array(string()).optional(),
	dangerouslyAllowNameMatching: boolean().optional(),
	markdown: MarkdownConfigSchema,
	configWrites: boolean().optional(),
	appId: string().optional(),
	appPassword: SecretInputSchema.optional().register(sensitive),
	tenantId: string().optional(),
	authType: _enum(["secret", "federated"]).optional(),
	certificatePath: string().optional(),
	certificateThumbprint: string().optional(),
	useManagedIdentity: boolean().optional(),
	managedIdentityClientId: string().optional(),
	webhook: object({
		port: number().int().positive().optional(),
		path: string().optional()
	}).strict().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: array(string()).optional(),
	defaultTo: string().optional(),
	groupAllowFrom: array(string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	textChunkLimit: number().int().positive().optional(),
	chunkMode: _enum(["length", "newline"]).optional(),
	streaming: ChannelPreviewStreamingConfigSchema.optional(),
	typingIndicator: boolean().optional(),
	blockStreaming: boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaAllowHosts: array(string()).optional(),
	mediaAuthAllowHosts: array(string()).optional(),
	requireMention: boolean().optional(),
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	dms: record(string(), DmConfigSchema.optional()).optional(),
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	teams: record(string(), MSTeamsTeamSchema.optional()).optional(),
	/** Max media size in MB (default: 100MB for OneDrive upload support). */
	mediaMaxMb: number().positive().optional(),
	/** SharePoint site ID for file uploads in group chats/channels (e.g., "contoso.sharepoint.com,guid1,guid2") */
	sharePointSiteId: string().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: string().optional(),
	welcomeCard: boolean().optional(),
	promptStarters: array(string()).optional(),
	groupWelcomeCard: boolean().optional(),
	feedbackEnabled: boolean().optional(),
	feedbackReflection: boolean().optional(),
	feedbackReflectionCooldownMs: number().int().min(0).optional(),
	delegatedAuth: object({
		enabled: boolean().optional(),
		scopes: array(string()).optional()
	}).strict().optional(),
	sso: object({
		enabled: boolean().optional(),
		connectionName: string().optional()
	}).strict().optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.msteams.dmPolicy=\"open\" requires channels.msteams.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.msteams.dmPolicy=\"allowlist\" requires channels.msteams.allowFrom to contain at least one sender ID"
	});
	if (value.sso?.enabled === true && !value.sso.connectionName?.trim()) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["sso", "connectionName"],
		message: "channels.msteams.sso.enabled=true requires channels.msteams.sso.connectionName to identify the Bot Framework OAuth connection"
	});
});
//#endregion
//#region src/config/zod-schema.providers-whatsapp.ts
const ToolPolicyBySenderSchema = record(string(), ToolPolicySchema).optional();
const WhatsAppGroupEntrySchema = object({
	requireMention: boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	systemPrompt: string().optional()
}).strict().optional();
const WhatsAppGroupsSchema = record(string(), WhatsAppGroupEntrySchema).optional();
const WhatsAppDirectEntrySchema = object({ systemPrompt: string().optional() }).strict().optional();
const WhatsAppDirectSchema = record(string(), WhatsAppDirectEntrySchema).optional();
const WhatsAppAckReactionSchema = object({
	emoji: string().optional(),
	direct: boolean().optional().default(true),
	group: _enum([
		"always",
		"mentions",
		"never"
	]).optional().default("mentions")
}).strict().optional();
function stripDeprecatedWhatsAppNoopKeys(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	if (!Object.hasOwn(value, "exposeErrorText")) return value;
	const next = { ...value };
	delete next.exposeErrorText;
	return next;
}
function buildWhatsAppCommonShape(params) {
	return {
		enabled: boolean().optional(),
		capabilities: array(string()).optional(),
		markdown: MarkdownConfigSchema,
		configWrites: boolean().optional(),
		sendReadReceipts: boolean().optional(),
		messagePrefix: string().optional(),
		responsePrefix: string().optional(),
		dmPolicy: params.useDefaults ? DmPolicySchema.optional().default("pairing") : DmPolicySchema.optional(),
		selfChatMode: boolean().optional(),
		allowFrom: array(string()).optional(),
		defaultTo: string().optional(),
		groupAllowFrom: array(string()).optional(),
		groupPolicy: params.useDefaults ? GroupPolicySchema.optional().default("allowlist") : GroupPolicySchema.optional(),
		contextVisibility: ContextVisibilityModeSchema.optional(),
		historyLimit: number().int().min(0).optional(),
		dmHistoryLimit: number().int().min(0).optional(),
		dms: record(string(), DmConfigSchema.optional()).optional(),
		textChunkLimit: number().int().positive().optional(),
		chunkMode: _enum(["length", "newline"]).optional(),
		blockStreaming: boolean().optional(),
		blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
		groups: WhatsAppGroupsSchema,
		direct: WhatsAppDirectSchema,
		ackReaction: WhatsAppAckReactionSchema,
		reactionLevel: _enum([
			"off",
			"ack",
			"minimal",
			"extensive"
		]).optional(),
		debounceMs: params.useDefaults ? number().int().nonnegative().optional().default(0) : number().int().nonnegative().optional(),
		replyToMode: ReplyToModeSchema.optional(),
		heartbeat: ChannelHeartbeatVisibilitySchema,
		healthMonitor: ChannelHealthMonitorSchema
	};
}
function enforceOpenDmPolicyAllowFromStar(params) {
	if (params.dmPolicy !== "open") return;
	if (normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []).includes("*")) return;
	params.ctx.addIssue({
		code: ZodIssueCode.custom,
		path: params.path ?? ["allowFrom"],
		message: params.message
	});
}
function enforceAllowlistDmPolicyAllowFrom(params) {
	if (params.dmPolicy !== "allowlist") return;
	if (normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []).length > 0) return;
	params.ctx.addIssue({
		code: ZodIssueCode.custom,
		path: params.path ?? ["allowFrom"],
		message: params.message
	});
}
const WhatsAppAccountSchema = preprocess(stripDeprecatedWhatsAppNoopKeys, object({
	...buildWhatsAppCommonShape({ useDefaults: false }),
	name: string().optional(),
	enabled: boolean().optional(),
	/** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
	authDir: string().optional(),
	mediaMaxMb: number().int().positive().optional()
}).strict());
const WhatsAppConfigSchema = preprocess(stripDeprecatedWhatsAppNoopKeys, object({
	...buildWhatsAppCommonShape({ useDefaults: true }),
	accounts: record(string(), WhatsAppAccountSchema.optional()).optional(),
	defaultAccount: string().optional(),
	mediaMaxMb: number().int().positive().optional().default(50),
	actions: object({
		reactions: boolean().optional(),
		sendMessage: boolean().optional(),
		polls: boolean().optional()
	}).strict().optional()
}).strict().superRefine((value, ctx) => {
	const defaultAccount = resolveAccountEntry(value.accounts, "default");
	enforceOpenDmPolicyAllowFromStar({
		dmPolicy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		message: "channels.whatsapp.dmPolicy=\"open\" requires channels.whatsapp.allowFrom to include \"*\""
	});
	enforceAllowlistDmPolicyAllowFrom({
		dmPolicy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		message: "channels.whatsapp.dmPolicy=\"allowlist\" requires channels.whatsapp.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? (accountId === "default" ? void 0 : defaultAccount?.dmPolicy) ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? (accountId === "default" ? void 0 : defaultAccount?.allowFrom) ?? value.allowFrom;
		enforceOpenDmPolicyAllowFromStar({
			dmPolicy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.whatsapp.accounts.*.dmPolicy=\"open\" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to include \"*\""
		});
		enforceAllowlistDmPolicyAllowFrom({
			dmPolicy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.whatsapp.accounts.*.dmPolicy=\"allowlist\" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to contain at least one sender ID"
		});
	}
}));
//#endregion
export { MSTeamsConfigSchema as a, TelegramConfigSchema as c, IMessageConfigSchema as i, DiscordConfigSchema as n, SignalConfigSchema as o, GoogleChatConfigSchema as r, SlackConfigSchema as s, WhatsAppConfigSchema as t };
