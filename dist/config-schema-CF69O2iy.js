import { l as ToolPolicySchema } from "./zod-schema.agent-runtime-CkLkDy5d.js";
import { h as MarkdownConfigSchema, i as ContextVisibilityModeSchema, l as GroupPolicySchema } from "./zod-schema.core-CrlgnnCI.js";
import { a as buildNestedDmConfigSchema, r as buildChannelConfigSchema, t as AllowFromListSchema } from "./config-schema-DftNRjDz.js";
import { s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-Dzal6cfS.js";
import { r as buildSecretInputSchema } from "./secret-input-DlbCRffO.js";
import "./channel-config-schema-BaJC-ytH.js";
import "./channel-config-primitives-CbQ414E1.js";
import { a as resolveMatrixAccountConfig } from "./account-config-DPIixDRe.js";
import { i as resolveMatrixAccount, r as resolveDefaultMatrixAccountId, t as listMatrixAccountIds } from "./accounts-CN2fnEaV.js";
import { t as normalizeMatrixAllowList } from "./allowlist-CBM3hNUS.js";
import { z } from "zod";
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
const matrixActionSchema = z.object({
	reactions: z.boolean().optional(),
	messages: z.boolean().optional(),
	pins: z.boolean().optional(),
	profile: z.boolean().optional(),
	memberInfo: z.boolean().optional(),
	channelInfo: z.boolean().optional(),
	verification: z.boolean().optional()
}).optional();
const matrixThreadBindingsSchema = z.object({
	enabled: z.boolean().optional(),
	idleHours: z.number().nonnegative().optional(),
	maxAgeHours: z.number().nonnegative().optional(),
	spawnSessions: z.boolean().optional(),
	defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
	spawnSubagentSessions: z.boolean().optional(),
	spawnAcpSessions: z.boolean().optional()
}).optional();
const matrixExecApprovalsSchema = z.object({
	enabled: z.boolean().optional(),
	approvers: AllowFromListSchema,
	agentFilter: z.array(z.string()).optional(),
	sessionFilter: z.array(z.string()).optional(),
	target: z.enum([
		"dm",
		"channel",
		"both"
	]).optional()
}).optional();
const matrixRoomSchema = z.object({
	account: z.string().optional(),
	enabled: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
	tools: ToolPolicySchema,
	autoReply: z.boolean().optional(),
	users: AllowFromListSchema,
	skills: z.array(z.string()).optional(),
	systemPrompt: z.string().optional()
}).optional();
const matrixNetworkSchema = z.object({ dangerouslyAllowPrivateNetwork: z.boolean().optional() }).strict().optional();
const matrixStreamingSchema = z.object({
	mode: z.enum([
		"partial",
		"quiet",
		"progress",
		"off"
	]).optional(),
	progress: z.object({
		label: z.union([z.string(), z.literal(false)]).optional(),
		labels: z.array(z.string()).optional(),
		maxLines: z.number().int().positive().optional(),
		toolProgress: z.boolean().optional()
	}).strict().optional(),
	preview: z.object({ toolProgress: z.boolean().optional() }).strict().optional()
}).strict();
const MatrixChannelConfigSchema = buildChannelConfigSchema(z.object({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	defaultAccount: z.string().optional(),
	accounts: z.record(z.string(), z.unknown()).optional(),
	markdown: MarkdownConfigSchema,
	homeserver: z.string().optional(),
	network: matrixNetworkSchema,
	proxy: z.string().optional(),
	userId: z.string().optional(),
	accessToken: buildSecretInputSchema().optional(),
	password: buildSecretInputSchema().optional(),
	deviceId: z.string().optional(),
	deviceName: z.string().optional(),
	avatarUrl: z.string().optional(),
	initialSyncLimit: z.number().optional(),
	encryption: z.boolean().optional(),
	allowlistOnly: z.boolean().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
	groupPolicy: GroupPolicySchema.optional(),
	contextVisibility: ContextVisibilityModeSchema.optional(),
	blockStreaming: z.boolean().optional(),
	streaming: z.union([
		z.enum([
			"partial",
			"quiet",
			"progress",
			"off"
		]),
		z.boolean(),
		matrixStreamingSchema
	]).optional(),
	replyToMode: z.enum([
		"off",
		"first",
		"all",
		"batched"
	]).optional(),
	threadReplies: z.enum([
		"off",
		"inbound",
		"always"
	]).optional(),
	textChunkLimit: z.number().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional(),
	ackReactionScope: z.enum([
		"group-mentions",
		"group-all",
		"direct",
		"all",
		"none",
		"off"
	]).optional(),
	reactionNotifications: z.enum(["off", "own"]).optional(),
	threadBindings: matrixThreadBindingsSchema,
	startupVerification: z.enum(["off", "if-unverified"]).optional(),
	startupVerificationCooldownHours: z.number().optional(),
	mediaMaxMb: z.number().optional(),
	historyLimit: z.number().int().min(0).optional(),
	autoJoin: z.enum([
		"always",
		"allowlist",
		"off"
	]).optional(),
	autoJoinAllowlist: AllowFromListSchema,
	groupAllowFrom: AllowFromListSchema,
	dm: buildNestedDmConfigSchema({
		sessionScope: z.enum(["per-user", "per-room"]).optional(),
		threadReplies: z.enum([
			"off",
			"inbound",
			"always"
		]).optional()
	}),
	execApprovals: matrixExecApprovalsSchema,
	groups: z.object({}).catchall(matrixRoomSchema).optional(),
	rooms: z.object({}).catchall(matrixRoomSchema).optional(),
	actions: matrixActionSchema
}), { uiHints: matrixChannelConfigUiHints });
//#endregion
export { matrixConfigAdapter as n, MatrixChannelConfigSchema as t };
