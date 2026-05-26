import { At as boolean, Et as array, Nn as record, Rn as string, Tn as object, Xn as union, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { h as MarkdownConfigSchema, i as ContextVisibilityModeSchema, l as GroupPolicySchema } from "./zod-schema.core-D7Y_eqdd.js";
import { u as ToolPolicySchema } from "./zod-schema.agent-runtime-Bq5CXVVg.js";
import { a as buildNestedDmConfigSchema, r as buildChannelConfigSchema, t as AllowFromListSchema } from "./config-schema-ChfiQrSg.js";
import { s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-xZ4-bv2H.js";
import { r as buildSecretInputSchema } from "./secret-input-CWnTb0tw.js";
import "./channel-config-schema-BBVXL5oD.js";
import "./channel-config-primitives-BKu_-glE.js";
import { a as resolveMatrixAccountConfig } from "./account-config-C6EZ3oG4.js";
import { i as resolveMatrixAccount, r as resolveDefaultMatrixAccountId, t as listMatrixAccountIds } from "./accounts-CAjG_HwT.js";
import { t as normalizeMatrixAllowList } from "./allowlist-hUx4DdC6.js";
//#region extensions/matrix/src/config-adapter.ts
const matrixConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: "matrix",
	listAccountIds: listMatrixAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccount),
	resolveAccessorAccount: ({ cfg, accountId }) => resolveMatrixAccountConfig({
		cfg,
		accountId
	}),
	defaultAccountId: resolveDefaultMatrixAccountId,
	clearBaseFields: [
		"name",
		"homeserver",
		"network",
		"proxy",
		"userId",
		"accessToken",
		"password",
		"deviceId",
		"deviceName",
		"avatarUrl",
		"initialSyncLimit"
	],
	resolveAllowFrom: (account) => account.dm?.allowFrom,
	formatAllowFrom: (allowFrom) => normalizeMatrixAllowList(allowFrom)
});
//#endregion
//#region extensions/matrix/src/config-ui-hints.ts
const matrixChannelConfigUiHints = {
	allowBots: {
		label: "Matrix Allow Bot Messages",
		help: "Allow messages from other configured Matrix bot accounts to trigger replies (default: false). Set \"mentions\" to require a visible room mention."
	},
	botLoopProtection: {
		label: "Matrix Bot Loop Protection",
		help: "Sliding-window guard for accepted Matrix configured-bot loops. Default is enabled whenever allowBots lets configured bot messages reach dispatch."
	},
	"botLoopProtection.enabled": {
		label: "Matrix Bot Loop Protection Enabled",
		help: "Enable the bot-pair loop guard. Defaults to true when allowBots is true or \"mentions\", and false when configured bot messages are ignored."
	},
	"botLoopProtection.maxEventsPerWindow": {
		label: "Matrix Bot Loop Events per Window",
		help: "Maximum accepted bot-pair messages within the sliding window before suppression starts. Default: 20."
	},
	"botLoopProtection.windowSeconds": {
		label: "Matrix Bot Loop Window Seconds",
		help: "Sliding window length for counting bot-pair messages. Default: 60."
	},
	"botLoopProtection.cooldownSeconds": {
		label: "Matrix Bot Loop Cooldown Seconds",
		help: "How long to suppress the bot pair after it exceeds the budget. Default: 60."
	},
	dangerouslyAllowNameMatching: {
		label: "Matrix Display Name Matching",
		help: "Compatibility opt-in for resolving Matrix display names and joined room names in allowlists. Prefer full @user:server IDs and room IDs or aliases because names are mutable."
	},
	"streaming.progress.label": {
		label: "Matrix Progress Label",
		help: "Initial progress draft title. Use \"auto\" for built-in single-word labels, a custom string, or false to hide the title."
	},
	"streaming.progress.labels": {
		label: "Matrix Progress Label Pool",
		help: "Candidate labels for streaming.progress.label=\"auto\". Leave unset to use OpenClaw built-in progress labels."
	},
	"streaming.progress.maxLines": {
		label: "Matrix Progress Max Lines",
		help: "Maximum number of compact progress lines to keep below the draft label (default: 8)."
	},
	"streaming.progress.maxLineChars": {
		label: "Matrix Progress Max Line Chars",
		help: "Maximum characters per compact progress line before truncation (default: 120). Prose cuts at word boundaries; commands and paths keep useful suffixes."
	},
	"streaming.progress.toolProgress": {
		label: "Matrix Progress Tool Lines",
		help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery."
	},
	"streaming.progress.commandText": {
		label: "Matrix Progress Command Text",
		help: "Command/exec detail in progress draft lines: \"raw\" preserves released behavior; \"status\" shows only the tool label."
	}
};
//#endregion
//#region extensions/matrix/src/config-schema.ts
const matrixActionSchema = object({
	reactions: boolean().optional(),
	messages: boolean().optional(),
	pins: boolean().optional(),
	profile: boolean().optional(),
	memberInfo: boolean().optional(),
	channelInfo: boolean().optional(),
	verification: boolean().optional()
}).optional();
const matrixThreadBindingsSchema = object({
	enabled: boolean().optional(),
	idleHours: number().nonnegative().optional(),
	maxAgeHours: number().nonnegative().optional(),
	spawnSessions: boolean().optional(),
	defaultSpawnContext: _enum(["isolated", "fork"]).optional(),
	spawnSubagentSessions: boolean().optional(),
	spawnAcpSessions: boolean().optional()
}).optional();
const matrixExecApprovalsSchema = object({
	enabled: boolean().optional(),
	approvers: AllowFromListSchema,
	agentFilter: array(string()).optional(),
	sessionFilter: array(string()).optional(),
	target: _enum([
		"dm",
		"channel",
		"both"
	]).optional()
}).optional();
const botLoopProtectionSchema = object({
	enabled: boolean().optional(),
	maxEventsPerWindow: number().int().positive().optional(),
	windowSeconds: number().int().positive().optional(),
	cooldownSeconds: number().int().positive().optional()
}).strict().optional();
const matrixRoomSchema = object({
	account: string().optional(),
	enabled: boolean().optional(),
	requireMention: boolean().optional(),
	allowBots: union([boolean(), literal("mentions")]).optional(),
	botLoopProtection: botLoopProtectionSchema,
	tools: ToolPolicySchema,
	autoReply: boolean().optional(),
	users: AllowFromListSchema,
	skills: array(string()).optional(),
	systemPrompt: string().optional()
}).optional();
const matrixNetworkSchema = object({ dangerouslyAllowPrivateNetwork: boolean().optional() }).strict().optional();
const matrixStreamingSchema = object({
	mode: _enum([
		"partial",
		"quiet",
		"progress",
		"off"
	]).optional(),
	progress: object({
		label: union([string(), literal(false)]).optional(),
		labels: array(string()).optional(),
		maxLines: number().int().positive().optional(),
		maxLineChars: number().int().positive().optional(),
		toolProgress: boolean().optional()
	}).strict().optional(),
	preview: object({ toolProgress: boolean().optional() }).strict().optional()
}).strict();
const MatrixChannelConfigSchema = buildChannelConfigSchema(object({
	name: string().optional(),
	enabled: boolean().optional(),
	defaultAccount: string().optional(),
	accounts: record(string(), unknown()).optional(),
	markdown: MarkdownConfigSchema,
	homeserver: string().optional(),
	network: matrixNetworkSchema,
	proxy: string().optional(),
	userId: string().optional(),
	accessToken: buildSecretInputSchema().optional(),
	password: buildSecretInputSchema().optional(),
	deviceId: string().optional(),
	deviceName: string().optional(),
	avatarUrl: string().optional(),
	initialSyncLimit: number().optional(),
	encryption: boolean().optional(),
	allowlistOnly: boolean().optional(),
	dangerouslyAllowNameMatching: boolean().optional(),
	allowBots: union([boolean(), literal("mentions")]).optional(),
	botLoopProtection: botLoopProtectionSchema,
	groupPolicy: GroupPolicySchema.optional(),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	blockStreaming: boolean().optional(),
	streaming: union([
		_enum([
			"partial",
			"quiet",
			"progress",
			"off"
		]),
		boolean(),
		matrixStreamingSchema
	]).optional(),
	replyToMode: _enum([
		"off",
		"first",
		"all",
		"batched"
	]).optional(),
	threadReplies: _enum([
		"off",
		"inbound",
		"always"
	]).optional(),
	textChunkLimit: number().optional(),
	chunkMode: _enum(["length", "newline"]).optional(),
	responsePrefix: string().optional(),
	ackReaction: string().optional(),
	ackReactionScope: _enum([
		"group-mentions",
		"group-all",
		"direct",
		"all",
		"none",
		"off"
	]).optional(),
	reactionNotifications: _enum(["off", "own"]).optional(),
	threadBindings: matrixThreadBindingsSchema,
	startupVerification: _enum(["off", "if-unverified"]).optional(),
	startupVerificationCooldownHours: number().optional(),
	mediaMaxMb: number().optional(),
	historyLimit: number().int().min(0).optional(),
	autoJoin: _enum([
		"always",
		"allowlist",
		"off"
	]).optional(),
	autoJoinAllowlist: AllowFromListSchema,
	groupAllowFrom: AllowFromListSchema,
	dm: buildNestedDmConfigSchema({
		sessionScope: _enum(["per-user", "per-room"]).optional(),
		threadReplies: _enum([
			"off",
			"inbound",
			"always"
		]).optional()
	}),
	execApprovals: matrixExecApprovalsSchema,
	groups: object({}).catchall(matrixRoomSchema).optional(),
	rooms: object({}).catchall(matrixRoomSchema).optional(),
	actions: matrixActionSchema
}), { uiHints: matrixChannelConfigUiHints });
//#endregion
export { matrixConfigAdapter as n, MatrixChannelConfigSchema as t };
