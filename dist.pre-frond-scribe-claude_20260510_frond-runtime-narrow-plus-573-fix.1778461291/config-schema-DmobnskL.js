import { l as ToolPolicySchema } from "./zod-schema.agent-runtime-C2B5h9xo.js";
import { h as MarkdownConfigSchema, i as ContextVisibilityModeSchema, l as GroupPolicySchema } from "./zod-schema.core-ZZiuAHri.js";
import { a as buildNestedDmConfigSchema, r as buildChannelConfigSchema, t as AllowFromListSchema } from "./config-schema-B1ZkUpkb.js";
import { s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-C5msK1mQ.js";
import { r as buildSecretInputSchema } from "./secret-input-CPrRyGK6.js";
import "./channel-config-schema-BZ5Hflbb.js";
import "./channel-config-primitives-BoZTAphr.js";
import { t as zod_exports } from "./zod-CH7V6TB8.js";
import { a as resolveMatrixAccountConfig } from "./account-config-DYZuM1DL.js";
import { i as resolveMatrixAccount, r as resolveDefaultMatrixAccountId, t as listMatrixAccountIds } from "./accounts-D5BKwb9m.js";
import { t as normalizeMatrixAllowList } from "./allowlist-CXvuA2-9.js";
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
const matrixActionSchema = zod_exports.z.object({
	reactions: zod_exports.z.boolean().optional(),
	messages: zod_exports.z.boolean().optional(),
	pins: zod_exports.z.boolean().optional(),
	profile: zod_exports.z.boolean().optional(),
	memberInfo: zod_exports.z.boolean().optional(),
	channelInfo: zod_exports.z.boolean().optional(),
	verification: zod_exports.z.boolean().optional()
}).optional();
const matrixThreadBindingsSchema = zod_exports.z.object({
	enabled: zod_exports.z.boolean().optional(),
	idleHours: zod_exports.z.number().nonnegative().optional(),
	maxAgeHours: zod_exports.z.number().nonnegative().optional(),
	spawnSessions: zod_exports.z.boolean().optional(),
	defaultSpawnContext: zod_exports.z.enum(["isolated", "fork"]).optional(),
	spawnSubagentSessions: zod_exports.z.boolean().optional(),
	spawnAcpSessions: zod_exports.z.boolean().optional()
}).optional();
const matrixExecApprovalsSchema = zod_exports.z.object({
	enabled: zod_exports.z.boolean().optional(),
	approvers: AllowFromListSchema,
	agentFilter: zod_exports.z.array(zod_exports.z.string()).optional(),
	sessionFilter: zod_exports.z.array(zod_exports.z.string()).optional(),
	target: zod_exports.z.enum([
		"dm",
		"channel",
		"both"
	]).optional()
}).optional();
const matrixRoomSchema = zod_exports.z.object({
	account: zod_exports.z.string().optional(),
	enabled: zod_exports.z.boolean().optional(),
	requireMention: zod_exports.z.boolean().optional(),
	allowBots: zod_exports.z.union([zod_exports.z.boolean(), zod_exports.z.literal("mentions")]).optional(),
	tools: ToolPolicySchema,
	autoReply: zod_exports.z.boolean().optional(),
	users: AllowFromListSchema,
	skills: zod_exports.z.array(zod_exports.z.string()).optional(),
	systemPrompt: zod_exports.z.string().optional()
}).optional();
const matrixNetworkSchema = zod_exports.z.object({ dangerouslyAllowPrivateNetwork: zod_exports.z.boolean().optional() }).strict().optional();
const matrixStreamingSchema = zod_exports.z.object({
	mode: zod_exports.z.enum([
		"partial",
		"quiet",
		"progress",
		"off"
	]).optional(),
	progress: zod_exports.z.object({
		label: zod_exports.z.union([zod_exports.z.string(), zod_exports.z.literal(false)]).optional(),
		labels: zod_exports.z.array(zod_exports.z.string()).optional(),
		maxLines: zod_exports.z.number().int().positive().optional(),
		toolProgress: zod_exports.z.boolean().optional()
	}).strict().optional(),
	preview: zod_exports.z.object({ toolProgress: zod_exports.z.boolean().optional() }).strict().optional()
}).strict();
const MatrixChannelConfigSchema = buildChannelConfigSchema(zod_exports.z.object({
	name: zod_exports.z.string().optional(),
	enabled: zod_exports.z.boolean().optional(),
	defaultAccount: zod_exports.z.string().optional(),
	accounts: zod_exports.z.record(zod_exports.z.string(), zod_exports.z.unknown()).optional(),
	markdown: MarkdownConfigSchema,
	homeserver: zod_exports.z.string().optional(),
	network: matrixNetworkSchema,
	proxy: zod_exports.z.string().optional(),
	userId: zod_exports.z.string().optional(),
	accessToken: buildSecretInputSchema().optional(),
	password: buildSecretInputSchema().optional(),
	deviceId: zod_exports.z.string().optional(),
	deviceName: zod_exports.z.string().optional(),
	avatarUrl: zod_exports.z.string().optional(),
	initialSyncLimit: zod_exports.z.number().optional(),
	encryption: zod_exports.z.boolean().optional(),
	allowlistOnly: zod_exports.z.boolean().optional(),
	allowBots: zod_exports.z.union([zod_exports.z.boolean(), zod_exports.z.literal("mentions")]).optional(),
	groupPolicy: GroupPolicySchema.optional(),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	blockStreaming: zod_exports.z.boolean().optional(),
	streaming: zod_exports.z.union([
		zod_exports.z.enum([
			"partial",
			"quiet",
			"progress",
			"off"
		]),
		zod_exports.z.boolean(),
		matrixStreamingSchema
	]).optional(),
	replyToMode: zod_exports.z.enum([
		"off",
		"first",
		"all",
		"batched"
	]).optional(),
	threadReplies: zod_exports.z.enum([
		"off",
		"inbound",
		"always"
	]).optional(),
	textChunkLimit: zod_exports.z.number().optional(),
	chunkMode: zod_exports.z.enum(["length", "newline"]).optional(),
	responsePrefix: zod_exports.z.string().optional(),
	ackReaction: zod_exports.z.string().optional(),
	ackReactionScope: zod_exports.z.enum([
		"group-mentions",
		"group-all",
		"direct",
		"all",
		"none",
		"off"
	]).optional(),
	reactionNotifications: zod_exports.z.enum(["off", "own"]).optional(),
	threadBindings: matrixThreadBindingsSchema,
	startupVerification: zod_exports.z.enum(["off", "if-unverified"]).optional(),
	startupVerificationCooldownHours: zod_exports.z.number().optional(),
	mediaMaxMb: zod_exports.z.number().optional(),
	historyLimit: zod_exports.z.number().int().min(0).optional(),
	autoJoin: zod_exports.z.enum([
		"always",
		"allowlist",
		"off"
	]).optional(),
	autoJoinAllowlist: AllowFromListSchema,
	groupAllowFrom: AllowFromListSchema,
	dm: buildNestedDmConfigSchema({
		sessionScope: zod_exports.z.enum(["per-user", "per-room"]).optional(),
		threadReplies: zod_exports.z.enum([
			"off",
			"inbound",
			"always"
		]).optional()
	}),
	execApprovals: matrixExecApprovalsSchema,
	groups: zod_exports.z.object({}).catchall(matrixRoomSchema).optional(),
	rooms: zod_exports.z.object({}).catchall(matrixRoomSchema).optional(),
	actions: matrixActionSchema
}), { uiHints: matrixChannelConfigUiHints });
//#endregion
export { matrixConfigAdapter as n, MatrixChannelConfigSchema as t };
