import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-BxqheYvy.js";
import { s as normalizeStringEntries } from "./string-normalization-DEwYgSEp.js";
import { l as ToolPolicySchema } from "./zod-schema.agent-runtime-CkLkDy5d.js";
import { C as SecretInputSchema, I as requireAllowlistAllowFrom, L as requireOpenAllowFrom, S as RetryConfigSchema, T as SecretRefSchema, a as DmConfigSchema, h as MarkdownConfigSchema, i as ContextVisibilityModeSchema, j as TtsConfigSchema, l as GroupPolicySchema, m as MSTeamsReplyStyleSchema, n as BlockStreamingCoalesceSchema, o as DmPolicySchema, s as ExecutableTokenSchema, t as BlockStreamingChunkSchema, u as HexColorSchema, v as ProviderCommandsSchema, x as ReplyToModeSchema } from "./zod-schema.core-CrlgnnCI.js";
import { t as sensitive } from "./zod-schema.sensitive-DZxjbqai.js";
import { t as isSafeScpRemoteHost } from "./scp-host-DHSZDDhg.js";
import { n as isValidInboundPathRootPattern } from "./inbound-path-policy-CMFnHCFD.js";
import { n as normalizeSlashCommandName, r as resolveCustomCommands, t as normalizeCommandDescription } from "./custom-command-config-DqBK2Av5.js";
import { t as resolveAccountEntry } from "./account-lookup-DAEppsQ5.js";
import { z } from "zod";
//#region src/config/zod-schema.channels.ts
const ChannelHeartbeatVisibilitySchema = z.object({
	showOk: z.boolean().optional(),
	showAlerts: z.boolean().optional(),
	useIndicator: z.boolean().optional()
}).strict().optional();
const ChannelHealthMonitorSchema = z.object({ enabled: z.boolean().optional() }).strict().optional();
//#endregion
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
		code: z.ZodIssueCode.custom,
		message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
		path: ["webhookSecret"]
	});
	forEachEnabledAccount(value.accounts, (accountId, account) => {
		if (!(normalizeOptionalString(account.webhookUrl) ?? "")) return;
		if (!hasConfiguredSecretInput(account.webhookSecret) && !hasBaseWebhookSecret) ctx.addIssue({
			code: z.ZodIssueCode.custom,
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
		code: z.ZodIssueCode.custom,
		message: "channels.slack.mode=\"http\" requires channels.slack.signingSecret",
		path: ["signingSecret"]
	});
	forEachEnabledAccount(value.accounts, (accountId, account) => {
		if ((account.mode === "http" || account.mode === "socket" ? account.mode : baseMode) !== "http") return;
		if (!hasConfiguredSecretInput(account.signingSecret ?? value.signingSecret)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
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
const ToolPolicyBySenderSchema$1 = z.record(z.string(), ToolPolicySchema).optional();
const DiscordIdSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value < 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Discord ID "${String(value)}" is not a valid non-negative safe integer. Wrap it in quotes in your config file.`
			});
			return z.NEVER;
		}
		return String(value);
	}
	return value;
}).pipe(z.string());
const DiscordIdListSchema = z.array(DiscordIdSchema);
const DiscordSnowflakeStringSchema = z.string().regex(/^\d+$/, "Discord user ID must be numeric");
const TelegramInlineButtonsScopeSchema = z.enum([
	"off",
	"dm",
	"group",
	"all",
	"allowlist"
]);
const TelegramIdListSchema = z.array(z.union([z.string(), z.number()]));
const TelegramCapabilitiesSchema = z.union([z.array(z.string()), z.object({ inlineButtons: TelegramInlineButtonsScopeSchema.optional() }).strict()]);
const TextChunkModeSchema = z.enum(["length", "newline"]);
const UnifiedStreamingModeSchema = z.enum([
	"off",
	"partial",
	"block",
	"progress"
]);
const ChannelStreamingBlockSchema = z.object({
	enabled: z.boolean().optional(),
	coalesce: BlockStreamingCoalesceSchema.optional()
}).strict();
const ChannelStreamingPreviewSchema = z.object({
	chunk: BlockStreamingChunkSchema.optional(),
	toolProgress: z.boolean().optional(),
	commandText: z.enum(["raw", "status"]).optional()
}).strict();
const ChannelStreamingProgressSchema = z.object({
	label: z.union([z.string(), z.literal(false)]).optional(),
	labels: z.array(z.string()).optional(),
	maxLines: z.number().int().positive().optional(),
	render: z.enum(["text", "rich"]).optional(),
	toolProgress: z.boolean().optional(),
	commandText: z.enum(["raw", "status"]).optional()
}).strict();
const ChannelPreviewStreamingConfigSchema = z.object({
	mode: UnifiedStreamingModeSchema.optional(),
	chunkMode: TextChunkModeSchema.optional(),
	preview: ChannelStreamingPreviewSchema.optional(),
	progress: ChannelStreamingProgressSchema.optional(),
	block: ChannelStreamingBlockSchema.optional()
}).strict();
const SlackStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({ nativeTransport: z.boolean().optional() }).strict();
const SlackCapabilitiesSchema = z.union([z.array(z.string()), z.object({ interactiveReplies: z.boolean().optional() }).strict()]);
const TelegramErrorPolicySchema = z.enum([
	"always",
	"once",
	"silent"
]).optional();
const TelegramCustomCommandConfig = {
	label: "Telegram",
	pattern: /^[a-z0-9_]{1,32}$/,
	patternDescription: "use a-z, 0-9, underscore; max 32 chars"
};
const TelegramTopicSchema = z.object({
	requireMention: z.boolean().optional(),
	ingest: z.boolean().optional(),
	disableAudioPreflight: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional(),
	agentId: z.string().optional(),
	errorPolicy: TelegramErrorPolicySchema,
	errorCooldownMs: z.number().int().nonnegative().optional()
}).strict();
const TelegramGroupSchema = z.object({
	requireMention: z.boolean().optional(),
	ingest: z.boolean().optional(),
	disableAudioPreflight: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional(),
	topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
	errorPolicy: TelegramErrorPolicySchema,
	errorCooldownMs: z.number().int().nonnegative().optional()
}).strict();
const TelegramDmThreadRepliesSchema = z.enum([
	"off",
	"inbound",
	"always"
]);
const TelegramDmSchema = z.object({ threadReplies: TelegramDmThreadRepliesSchema.optional() }).strict();
const AutoTopicLabelSchema = z.union([z.boolean(), z.object({
	enabled: z.boolean().optional(),
	prompt: z.string().optional()
}).strict()]).optional();
const TelegramDirectSchema = z.object({
	dmPolicy: DmPolicySchema.optional(),
	threadReplies: z.enum([
		"off",
		"inbound",
		"always"
	]).optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional(),
	topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
	errorPolicy: TelegramErrorPolicySchema,
	errorCooldownMs: z.number().int().nonnegative().optional(),
	requireTopic: z.boolean().optional(),
	autoTopicLabel: AutoTopicLabelSchema
}).strict();
const TelegramCustomCommandSchema = z.object({
	command: z.string().overwrite(normalizeSlashCommandName),
	description: z.string().overwrite(normalizeCommandDescription)
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
		code: z.ZodIssueCode.custom,
		path: [
			"customCommands",
			issue.index,
			issue.field
		],
		message: issue.message
	});
};
const TelegramAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: TelegramCapabilitiesSchema.optional(),
	execApprovals: z.object({
		enabled: z.boolean().optional(),
		approvers: TelegramIdListSchema.optional(),
		agentFilter: z.array(z.string()).optional(),
		sessionFilter: z.array(z.string()).optional(),
		target: z.enum([
			"dm",
			"channel",
			"both"
		]).optional()
	}).strict().optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	customCommands: z.array(TelegramCustomCommandSchema).optional(),
	configWrites: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	botToken: SecretInputSchema.optional().register(sensitive),
	tokenFile: z.string().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	dm: TelegramDmSchema.optional(),
	groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.union([z.string(), z.number()]).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	direct: z.record(z.string(), TelegramDirectSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	streaming: ChannelPreviewStreamingConfigSchema.optional(),
	mediaMaxMb: z.number().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	mediaGroupFlushMs: z.number().int().min(10).max(6e4).optional().describe("Buffer window in milliseconds for Telegram media groups/albums before dispatching them as one inbound message. Default: 500."),
	pollingStallThresholdMs: z.number().int().min(3e4).max(6e5).optional(),
	retry: RetryConfigSchema,
	network: z.object({
		autoSelectFamily: z.boolean().optional(),
		dnsResultOrder: z.enum(["ipv4first", "verbatim"]).optional(),
		dangerouslyAllowPrivateNetwork: z.boolean().optional().describe("Dangerous opt-in for trusted Telegram fake-IP or transparent-proxy environments where api.telegram.org resolves to private/internal/special-use addresses during media downloads.")
	}).strict().optional(),
	proxy: z.string().optional(),
	webhookUrl: z.string().optional().describe("Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret."),
	webhookSecret: SecretInputSchema.optional().describe("Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.").register(sensitive),
	webhookPath: z.string().optional().describe("Local webhook route path served by the gateway listener. Defaults to /telegram-webhook."),
	webhookHost: z.string().optional().describe("Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress."),
	webhookPort: z.number().int().nonnegative().optional().describe("Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port."),
	webhookCertPath: z.string().optional().describe("Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. Required for self-signed certs (direct IP or no domain)."),
	actions: z.object({
		reactions: z.boolean().optional(),
		sendMessage: z.boolean().optional(),
		poll: z.boolean().optional(),
		deleteMessage: z.boolean().optional(),
		editMessage: z.boolean().optional(),
		sticker: z.boolean().optional(),
		createForumTopic: z.boolean().optional(),
		editForumTopic: z.boolean().optional()
	}).strict().optional(),
	threadBindings: z.object({
		enabled: z.boolean().optional(),
		idleHours: z.number().nonnegative().optional(),
		maxAgeHours: z.number().nonnegative().optional(),
		spawnSessions: z.boolean().optional(),
		defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
		spawnSubagentSessions: z.boolean().optional(),
		spawnAcpSessions: z.boolean().optional()
	}).strict().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all"
	]).optional(),
	reactionLevel: z.enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	linkPreview: z.boolean().optional(),
	silentErrorReplies: z.boolean().optional(),
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional(),
	errorPolicy: TelegramErrorPolicySchema,
	errorCooldownMs: z.number().int().nonnegative().optional(),
	apiRoot: z.string().url().optional(),
	trustedLocalFileRoots: z.array(z.string()).optional().describe("Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths under these roots are read directly; all other absolute paths are rejected."),
	autoTopicLabel: AutoTopicLabelSchema
}).strict();
const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
	validateTelegramCustomCommands(value, ctx);
});
const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
	accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
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
const DiscordDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional(),
	allowFrom: DiscordIdListSchema.optional(),
	groupEnabled: z.boolean().optional(),
	groupChannels: DiscordIdListSchema.optional()
}).strict();
const DiscordThreadSchema = z.object({ inheritParent: z.boolean().optional() }).strict();
const DiscordGuildChannelSchema = z.object({
	requireMention: z.boolean().optional(),
	ignoreOtherMentions: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	users: DiscordIdListSchema.optional(),
	roles: DiscordIdListSchema.optional(),
	systemPrompt: z.string().optional(),
	includeThreadStarter: z.boolean().optional(),
	autoThread: z.boolean().optional(),
	/** Naming strategy for auto-created threads. "message" uses message text; "generated" creates an LLM title after thread creation. */
	autoThreadName: z.enum(["message", "generated"]).optional(),
	/** Archive duration for auto-created threads in minutes. Discord supports 60, 1440 (1 day), 4320 (3 days), 10080 (1 week). Default: 60. */
	autoArchiveDuration: z.union([
		z.enum([
			"60",
			"1440",
			"4320",
			"10080"
		]),
		z.literal(60),
		z.literal(1440),
		z.literal(4320),
		z.literal(10080)
	]).optional()
}).strict();
const DiscordGuildSchema = z.object({
	slug: z.string().optional(),
	requireMention: z.boolean().optional(),
	ignoreOtherMentions: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	users: DiscordIdListSchema.optional(),
	roles: DiscordIdListSchema.optional(),
	channels: z.record(z.string(), DiscordGuildChannelSchema.optional()).optional()
}).strict();
const DiscordUiSchema = z.object({ components: z.object({ accentColor: HexColorSchema.optional() }).strict().optional() }).strict().optional();
const DiscordVoiceAutoJoinSchema = z.object({
	guildId: z.string().min(1),
	channelId: z.string().min(1)
}).strict();
const DiscordVoiceAllowedChannelSchema = z.object({
	guildId: z.string().min(1),
	channelId: z.string().min(1)
}).strict();
const DiscordVoiceRealtimeToolPolicySchema = z.enum([
	"safe-read-only",
	"owner",
	"none"
]);
const DiscordVoiceRealtimeConsultPolicySchema = z.enum(["auto", "always"]);
const DiscordVoiceRealtimeSchema = z.object({
	provider: z.string().min(1).optional(),
	model: z.string().min(1).optional(),
	voice: z.string().min(1).optional(),
	instructions: z.string().min(1).optional(),
	toolPolicy: DiscordVoiceRealtimeToolPolicySchema.optional(),
	consultPolicy: DiscordVoiceRealtimeConsultPolicySchema.optional(),
	bargeIn: z.boolean().optional(),
	minBargeInAudioEndMs: z.number().int().min(0).max(1e4).optional(),
	debounceMs: z.number().int().positive().max(1e4).optional(),
	providers: z.record(z.string(), z.record(z.string(), z.unknown()).optional()).optional()
}).strict();
const DiscordVoiceAgentSessionSchema = z.object({
	mode: z.enum(["voice", "target"]).optional(),
	target: z.string().min(1).optional()
}).strict().superRefine((value, ctx) => {
	if (value.mode === "target" && !value.target) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["target"],
		message: "voice.agentSession.target is required when mode is \"target\""
	});
});
const DiscordVoiceSchema = z.object({
	enabled: z.boolean().optional(),
	mode: z.enum([
		"stt-tts",
		"agent-proxy",
		"bidi"
	]).optional(),
	agentSession: DiscordVoiceAgentSessionSchema.optional(),
	model: z.string().min(1).optional(),
	realtime: DiscordVoiceRealtimeSchema.optional(),
	autoJoin: z.array(DiscordVoiceAutoJoinSchema).optional(),
	allowedChannels: z.array(DiscordVoiceAllowedChannelSchema).optional(),
	daveEncryption: z.boolean().optional(),
	decryptionFailureTolerance: z.number().int().min(0).optional(),
	connectTimeoutMs: z.number().int().positive().max(12e4).optional(),
	reconnectGraceMs: z.number().int().positive().max(12e4).optional(),
	captureSilenceGraceMs: z.number().int().positive().max(3e4).optional(),
	tts: TtsConfigSchema.optional()
}).strict().optional();
const DiscordAccountSchema = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: z.boolean().optional(),
	token: SecretInputSchema.optional().register(sensitive),
	applicationId: DiscordIdSchema.optional(),
	proxy: z.string().optional(),
	gatewayInfoTimeoutMs: z.number().int().positive().max(12e4).optional(),
	gatewayReadyTimeoutMs: z.number().int().positive().max(12e4).optional(),
	gatewayRuntimeReadyTimeoutMs: z.number().int().positive().max(12e4).optional(),
	allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	mentionAliases: z.record(z.string(), DiscordSnowflakeStringSchema).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	streaming: ChannelPreviewStreamingConfigSchema.optional(),
	maxLinesPerMessage: z.number().int().positive().optional(),
	mediaMaxMb: z.number().positive().optional(),
	retry: RetryConfigSchema,
	actions: z.object({
		reactions: z.boolean().optional(),
		stickers: z.boolean().optional(),
		emojiUploads: z.boolean().optional(),
		stickerUploads: z.boolean().optional(),
		polls: z.boolean().optional(),
		permissions: z.boolean().optional(),
		messages: z.boolean().optional(),
		threads: z.boolean().optional(),
		pins: z.boolean().optional(),
		search: z.boolean().optional(),
		memberInfo: z.boolean().optional(),
		roleInfo: z.boolean().optional(),
		roles: z.boolean().optional(),
		channelInfo: z.boolean().optional(),
		voiceStatus: z.boolean().optional(),
		events: z.boolean().optional(),
		moderation: z.boolean().optional(),
		channels: z.boolean().optional(),
		presence: z.boolean().optional()
	}).strict().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	thread: DiscordThreadSchema.optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: DiscordIdListSchema.optional(),
	defaultTo: z.string().optional(),
	dm: DiscordDmSchema.optional(),
	guilds: z.record(z.string(), DiscordGuildSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	execApprovals: z.object({
		enabled: z.boolean().optional(),
		approvers: DiscordIdListSchema.optional(),
		agentFilter: z.array(z.string()).optional(),
		sessionFilter: z.array(z.string()).optional(),
		cleanupAfterResolve: z.boolean().optional(),
		target: z.enum([
			"dm",
			"channel",
			"both"
		]).optional()
	}).strict().optional(),
	agentComponents: z.object({ enabled: z.boolean().optional() }).strict().optional(),
	ui: DiscordUiSchema,
	slashCommand: z.object({ ephemeral: z.boolean().optional() }).strict().optional(),
	threadBindings: z.object({
		enabled: z.boolean().optional(),
		idleHours: z.number().nonnegative().optional(),
		maxAgeHours: z.number().nonnegative().optional(),
		spawnSessions: z.boolean().optional(),
		defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
		spawnSubagentSessions: z.boolean().optional(),
		spawnAcpSessions: z.boolean().optional()
	}).strict().optional(),
	intents: z.object({
		presence: z.boolean().optional(),
		guildMembers: z.boolean().optional(),
		voiceStates: z.boolean().optional()
	}).strict().optional(),
	voice: DiscordVoiceSchema,
	pluralkit: z.object({
		enabled: z.boolean().optional(),
		token: SecretInputSchema.optional().register(sensitive)
	}).strict().optional(),
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional(),
	ackReactionScope: z.enum([
		"group-mentions",
		"group-all",
		"direct",
		"all",
		"off",
		"none"
	]).optional(),
	activity: z.string().optional(),
	status: z.enum([
		"online",
		"dnd",
		"idle",
		"invisible"
	]).optional(),
	autoPresence: z.object({
		enabled: z.boolean().optional(),
		intervalMs: z.number().int().positive().optional(),
		minUpdateIntervalMs: z.number().int().positive().optional(),
		healthyText: z.string().optional(),
		degradedText: z.string().optional(),
		exhaustedText: z.string().optional()
	}).strict().optional(),
	activityType: z.union([
		z.literal(0),
		z.literal(1),
		z.literal(2),
		z.literal(3),
		z.literal(4),
		z.literal(5)
	]).optional(),
	activityUrl: z.string().url().optional(),
	inboundWorker: z.object({ runTimeoutMs: z.number().int().nonnegative().optional() }).strict().optional(),
	eventQueue: z.object({
		listenerTimeout: z.number().int().positive().optional(),
		maxQueueSize: z.number().int().positive().optional(),
		maxConcurrency: z.number().int().positive().optional()
	}).strict().optional()
}).strict().superRefine((value, ctx) => {
	const activityText = normalizeOptionalString(value.activity) ?? "";
	const hasActivity = Boolean(activityText);
	const hasActivityType = value.activityType !== void 0;
	const activityUrl = normalizeOptionalString(value.activityUrl) ?? "";
	const hasActivityUrl = Boolean(activityUrl);
	if ((hasActivityType || hasActivityUrl) && !hasActivity) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.activity is required when activityType or activityUrl is set",
		path: ["activity"]
	});
	if (value.activityType === 1 && !hasActivityUrl) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.activityUrl is required when activityType is 1 (Streaming)",
		path: ["activityUrl"]
	});
	if (hasActivityUrl && value.activityType !== 1) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.activityType must be 1 (Streaming) when activityUrl is set",
		path: ["activityType"]
	});
	const autoPresenceInterval = value.autoPresence?.intervalMs;
	const autoPresenceMinUpdate = value.autoPresence?.minUpdateIntervalMs;
	if (typeof autoPresenceInterval === "number" && typeof autoPresenceMinUpdate === "number" && autoPresenceMinUpdate > autoPresenceInterval) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.autoPresence.minUpdateIntervalMs must be less than or equal to channels.discord.autoPresence.intervalMs",
		path: ["autoPresence", "minUpdateIntervalMs"]
	});
});
const DiscordConfigSchema = DiscordAccountSchema.extend({
	accounts: z.record(z.string(), DiscordAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
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
const GoogleChatDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional()
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
const GoogleChatGroupSchema = z.object({
	enabled: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const GoogleChatAccountSchema = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	allowBots: z.boolean().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
	defaultTo: z.string().optional(),
	serviceAccount: z.union([
		z.string(),
		z.record(z.string(), z.unknown()),
		SecretRefSchema
	]).optional().register(sensitive),
	serviceAccountRef: SecretRefSchema.optional().register(sensitive),
	serviceAccountFile: z.string().optional(),
	audienceType: z.enum(["app-url", "project-number"]).optional(),
	audience: z.string().optional(),
	appPrincipal: z.string().optional(),
	webhookPath: z.string().optional(),
	webhookUrl: z.string().optional(),
	botUser: z.string().optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().positive().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	actions: z.object({ reactions: z.boolean().optional() }).strict().optional(),
	dm: GoogleChatDmSchema.optional(),
	healthMonitor: ChannelHealthMonitorSchema,
	typingIndicator: z.enum([
		"none",
		"message",
		"reaction"
	]).optional(),
	responsePrefix: z.string().optional()
}).strict();
const GoogleChatConfigSchema = GoogleChatAccountSchema.extend({
	accounts: z.record(z.string(), GoogleChatAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
});
const SlackDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupEnabled: z.boolean().optional(),
	groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
	replyToMode: ReplyToModeSchema.optional()
}).strict();
const SlackChannelSchema = z.object({
	enabled: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	skills: z.array(z.string()).optional(),
	systemPrompt: z.string().optional()
}).strict();
const SlackThreadSchema = z.object({
	historyScope: z.enum(["thread", "channel"]).optional(),
	inheritParent: z.boolean().optional(),
	initialHistoryLimit: z.number().int().min(0).optional(),
	requireExplicitMention: z.boolean().optional()
}).strict();
const SlackReplyToModeByChatTypeSchema = z.object({
	direct: ReplyToModeSchema.optional(),
	group: ReplyToModeSchema.optional(),
	channel: ReplyToModeSchema.optional()
}).strict();
const SlackSocketModeSchema = z.object({
	clientPingTimeout: z.number().int().positive().optional(),
	serverPingTimeout: z.number().int().positive().optional(),
	pingPongLoggingEnabled: z.boolean().optional()
}).strict();
const SlackAccountSchema = z.object({
	name: z.string().optional(),
	mode: z.enum(["socket", "http"]).optional(),
	socketMode: SlackSocketModeSchema.optional(),
	signingSecret: SecretInputSchema.optional().register(sensitive),
	webhookPath: z.string().optional(),
	capabilities: SlackCapabilitiesSchema.optional(),
	execApprovals: z.object({
		enabled: z.boolean().optional(),
		approvers: z.array(z.union([z.string(), z.number()])).optional(),
		agentFilter: z.array(z.string()).optional(),
		sessionFilter: z.array(z.string()).optional(),
		target: z.enum([
			"dm",
			"channel",
			"both"
		]).optional()
	}).strict().optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: z.boolean().optional(),
	botToken: SecretInputSchema.optional().register(sensitive),
	appToken: SecretInputSchema.optional().register(sensitive),
	userToken: SecretInputSchema.optional().register(sensitive),
	userTokenReadOnly: z.boolean().optional().default(true),
	allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	unfurlLinks: z.boolean().optional(),
	unfurlMedia: z.boolean().optional(),
	streaming: SlackStreamingConfigSchema.optional(),
	mediaMaxMb: z.number().positive().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
	replyToMode: ReplyToModeSchema.optional(),
	replyToModeByChatType: SlackReplyToModeByChatTypeSchema.optional(),
	thread: SlackThreadSchema.optional(),
	actions: z.object({
		reactions: z.boolean().optional(),
		messages: z.boolean().optional(),
		pins: z.boolean().optional(),
		search: z.boolean().optional(),
		permissions: z.boolean().optional(),
		memberInfo: z.boolean().optional(),
		channelInfo: z.boolean().optional(),
		emojiList: z.boolean().optional()
	}).strict().optional(),
	slashCommand: z.object({
		enabled: z.boolean().optional(),
		name: z.string().optional(),
		sessionPrefix: z.string().optional(),
		ephemeral: z.boolean().optional()
	}).strict().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	dm: SlackDmSchema.optional(),
	channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional(),
	typingReaction: z.string().optional()
}).strict().superRefine(() => {});
const SlackConfigSchema = SlackAccountSchema.safeExtend({
	mode: z.enum(["socket", "http"]).optional().default("socket"),
	signingSecret: SecretInputSchema.optional().register(sensitive),
	webhookPath: z.string().optional().default("/slack/events"),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	accounts: z.record(z.string(), SlackAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
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
const SignalGroupEntrySchema = z.object({
	requireMention: z.boolean().optional(),
	ingest: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1
}).strict();
const SignalGroupsSchema = z.record(z.string(), SignalGroupEntrySchema.optional()).optional();
const SignalAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	account: z.string().optional(),
	accountUuid: z.string().optional(),
	httpUrl: z.string().optional(),
	httpHost: z.string().optional(),
	httpPort: z.number().int().positive().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	autoStart: z.boolean().optional(),
	startupTimeoutMs: z.number().int().min(1e3).max(12e4).optional(),
	receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
	ignoreAttachments: z.boolean().optional(),
	ignoreStories: z.boolean().optional(),
	sendReadReceipts: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	groups: SignalGroupsSchema,
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
	actions: z.object({ reactions: z.boolean().optional() }).strict().optional(),
	reactionLevel: z.enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional()
}).strict();
const SignalAccountSchema = SignalAccountSchemaBase;
const SignalConfigSchema = SignalAccountSchemaBase.extend({
	apiMode: z.enum([
		"auto",
		"native",
		"container"
	]).optional(),
	accounts: z.record(z.string(), SignalAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
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
const IrcGroupSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const IrcNickServSchema = z.object({
	enabled: z.boolean().optional(),
	service: z.string().optional(),
	password: SecretInputSchema.optional().register(sensitive),
	passwordFile: z.string().optional(),
	register: z.boolean().optional(),
	registerEmail: z.string().optional()
}).strict();
const IrcAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	host: z.string().optional(),
	port: z.number().int().min(1).max(65535).optional(),
	tls: z.boolean().optional(),
	nick: z.string().optional(),
	username: z.string().optional(),
	realname: z.string().optional(),
	password: SecretInputSchema.optional().register(sensitive),
	passwordFile: z.string().optional(),
	nickserv: IrcNickServSchema.optional(),
	channels: z.array(z.string()).optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	groups: z.record(z.string(), IrcGroupSchema.optional()).optional(),
	mentionPatterns: z.array(z.string()).optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().positive().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional()
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
		code: z.ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
}
const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
	if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
});
IrcAccountSchemaBase.extend({
	accounts: z.record(z.string(), IrcAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
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
const IMessageActionSchema = z.object({
	reactions: z.boolean().optional(),
	edit: z.boolean().optional(),
	unsend: z.boolean().optional(),
	reply: z.boolean().optional(),
	sendWithEffect: z.boolean().optional(),
	renameGroup: z.boolean().optional(),
	setGroupIcon: z.boolean().optional(),
	addParticipant: z.boolean().optional(),
	removeParticipant: z.boolean().optional(),
	leaveGroup: z.boolean().optional(),
	sendAttachment: z.boolean().optional()
}).strict().optional();
const IMessageAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	dbPath: z.string().optional(),
	remoteHost: z.string().refine(isSafeScpRemoteHost, "expected SSH host or user@host (no spaces/options)").optional(),
	actions: IMessageActionSchema,
	service: z.union([
		z.literal("imessage"),
		z.literal("sms"),
		z.literal("auto")
	]).optional(),
	region: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	includeAttachments: z.boolean().optional(),
	attachmentRoots: z.array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root")).optional(),
	remoteAttachmentRoots: z.array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root")).optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	probeTimeoutMs: z.number().int().positive().optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	sendReadReceipts: z.boolean().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all"
	]).optional(),
	coalesceSameSenderDms: z.boolean().optional(),
	groups: z.record(z.string(), z.object({
		requireMention: z.boolean().optional(),
		tools: ToolPolicySchema,
		toolsBySender: ToolPolicyBySenderSchema$1,
		systemPrompt: z.string().optional()
	}).strict().optional()).optional(),
	catchup: z.object({
		enabled: z.boolean().optional(),
		maxAgeMinutes: z.number().int().min(1).max(720).optional(),
		perRunLimit: z.number().int().min(1).max(500).optional(),
		firstRunLookbackMinutes: z.number().int().min(1).max(720).optional(),
		maxFailureRetries: z.number().int().min(1).max(1e3).optional()
	}).strict().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional()
}).strict();
const IMessageAccountSchema = IMessageAccountSchemaBase;
const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
	accounts: z.record(z.string(), IMessageAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
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
const MSTeamsChannelSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	replyStyle: MSTeamsReplyStyleSchema.optional()
}).strict();
const MSTeamsTeamSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional()
}).strict();
const MSTeamsConfigSchema = z.object({
	enabled: z.boolean().optional(),
	capabilities: z.array(z.string()).optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	appId: z.string().optional(),
	appPassword: SecretInputSchema.optional().register(sensitive),
	tenantId: z.string().optional(),
	authType: z.enum(["secret", "federated"]).optional(),
	certificatePath: z.string().optional(),
	certificateThumbprint: z.string().optional(),
	useManagedIdentity: z.boolean().optional(),
	managedIdentityClientId: z.string().optional(),
	webhook: z.object({
		port: z.number().int().positive().optional(),
		path: z.string().optional()
	}).strict().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.string()).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	streaming: ChannelPreviewStreamingConfigSchema.optional(),
	typingIndicator: z.boolean().optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaAllowHosts: z.array(z.string()).optional(),
	mediaAuthAllowHosts: z.array(z.string()).optional(),
	requireMention: z.boolean().optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
	/** Max media size in MB (default: 100MB for OneDrive upload support). */
	mediaMaxMb: z.number().positive().optional(),
	/** SharePoint site ID for file uploads in group chats/channels (e.g., "contoso.sharepoint.com,guid1,guid2") */
	sharePointSiteId: z.string().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional(),
	welcomeCard: z.boolean().optional(),
	promptStarters: z.array(z.string()).optional(),
	groupWelcomeCard: z.boolean().optional(),
	feedbackEnabled: z.boolean().optional(),
	feedbackReflection: z.boolean().optional(),
	feedbackReflectionCooldownMs: z.number().int().min(0).optional(),
	delegatedAuth: z.object({
		enabled: z.boolean().optional(),
		scopes: z.array(z.string()).optional()
	}).strict().optional(),
	sso: z.object({
		enabled: z.boolean().optional(),
		connectionName: z.string().optional()
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
		code: z.ZodIssueCode.custom,
		path: ["sso", "connectionName"],
		message: "channels.msteams.sso.enabled=true requires channels.msteams.sso.connectionName to identify the Bot Framework OAuth connection"
	});
});
//#endregion
//#region src/config/zod-schema.providers-whatsapp.ts
const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();
const WhatsAppGroupEntrySchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	systemPrompt: z.string().optional()
}).strict().optional();
const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();
const WhatsAppDirectEntrySchema = z.object({ systemPrompt: z.string().optional() }).strict().optional();
const WhatsAppDirectSchema = z.record(z.string(), WhatsAppDirectEntrySchema).optional();
const WhatsAppAckReactionSchema = z.object({
	emoji: z.string().optional(),
	direct: z.boolean().optional().default(true),
	group: z.enum([
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
		enabled: z.boolean().optional(),
		capabilities: z.array(z.string()).optional(),
		markdown: MarkdownConfigSchema,
		configWrites: z.boolean().optional(),
		sendReadReceipts: z.boolean().optional(),
		messagePrefix: z.string().optional(),
		responsePrefix: z.string().optional(),
		dmPolicy: params.useDefaults ? DmPolicySchema.optional().default("pairing") : DmPolicySchema.optional(),
		selfChatMode: z.boolean().optional(),
		allowFrom: z.array(z.string()).optional(),
		defaultTo: z.string().optional(),
		groupAllowFrom: z.array(z.string()).optional(),
		groupPolicy: params.useDefaults ? GroupPolicySchema.optional().default("allowlist") : GroupPolicySchema.optional(),
		contextVisibility: ContextVisibilityModeSchema.optional(),
		historyLimit: z.number().int().min(0).optional(),
		dmHistoryLimit: z.number().int().min(0).optional(),
		dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
		textChunkLimit: z.number().int().positive().optional(),
		chunkMode: z.enum(["length", "newline"]).optional(),
		blockStreaming: z.boolean().optional(),
		blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
		groups: WhatsAppGroupsSchema,
		direct: WhatsAppDirectSchema,
		ackReaction: WhatsAppAckReactionSchema,
		reactionLevel: z.enum([
			"off",
			"ack",
			"minimal",
			"extensive"
		]).optional(),
		debounceMs: params.useDefaults ? z.number().int().nonnegative().optional().default(0) : z.number().int().nonnegative().optional(),
		replyToMode: ReplyToModeSchema.optional(),
		heartbeat: ChannelHeartbeatVisibilitySchema,
		healthMonitor: ChannelHealthMonitorSchema
	};
}
function enforceOpenDmPolicyAllowFromStar(params) {
	if (params.dmPolicy !== "open") return;
	if (normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []).includes("*")) return;
	params.ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: params.path ?? ["allowFrom"],
		message: params.message
	});
}
function enforceAllowlistDmPolicyAllowFrom(params) {
	if (params.dmPolicy !== "allowlist") return;
	if (normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []).length > 0) return;
	params.ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: params.path ?? ["allowFrom"],
		message: params.message
	});
}
const WhatsAppAccountObjectSchema = z.object({
	...buildWhatsAppCommonShape({ useDefaults: false }),
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	/** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
	authDir: z.string().optional(),
	mediaMaxMb: z.number().int().positive().optional()
}).strict();
const WhatsAppAccountSchema = z.preprocess(stripDeprecatedWhatsAppNoopKeys, WhatsAppAccountObjectSchema);
const WhatsAppConfigObjectSchema = z.object({
	...buildWhatsAppCommonShape({ useDefaults: true }),
	accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional(),
	mediaMaxMb: z.number().int().positive().optional().default(50),
	actions: z.object({
		reactions: z.boolean().optional(),
		sendMessage: z.boolean().optional(),
		polls: z.boolean().optional()
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
});
const WhatsAppConfigSchema = z.preprocess(stripDeprecatedWhatsAppNoopKeys, WhatsAppConfigObjectSchema);
//#endregion
export { MSTeamsConfigSchema as a, TelegramConfigSchema as c, IMessageConfigSchema as i, ChannelHeartbeatVisibilitySchema as l, DiscordConfigSchema as n, SignalConfigSchema as o, GoogleChatConfigSchema as r, SlackConfigSchema as s, WhatsAppConfigSchema as t };
