import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { bn as buildChannelConfigSchema, dn as PAIRING_APPROVED_MESSAGE } from "./resolve-route-BZ4hHpx2.js";
import { i as hasConfiguredSecretInput } from "./types.secrets-apkw3WZr.js";
import { Bu as buildProbeChannelStatusSummary, Cp as mapAllowFromEntries, Vu as buildRuntimeAccountStatusSnapshot, Wu as createDefaultChannelRuntimeState, _o as listFeishuAccountIds, bo as resolveFeishuCredentials, bt as formatAllowFromLowercase, go as listEnabledFeishuAccounts, k as collectAllowlistProviderRestrictSendersWarnings, ko as buildSecretInputSchema, lo as feishuSetupWizard, po as createFeishuClient, to as parseFeishuConversationId, uo as feishuSetupAdapter, vo as resolveDefaultFeishuAccountId, yo as resolveFeishuAccount } from "./auth-profiles-CuJtivJK.js";
import { _ as createActionGate } from "./external-content-vZzOHxnd.js";
import { i as normalizeFeishuTarget, r as looksLikeFeishuId, t as getFeishuRuntime } from "./runtime-DJop-aJ1.js";
import { n as listFeishuDirectoryPeers, t as listFeishuDirectoryGroups } from "./directory.static-1SWT3bN6.js";
import { i as resolveFeishuGroupToolPolicy } from "./policy-C7DBVel8.js";
import { z as z$1 } from "zod";
//#region extensions/feishu/src/config-schema.ts
const ChannelActionsSchema = z$1.object({ reactions: z$1.boolean().optional() }).strict().optional();
const DmPolicySchema = z$1.enum([
	"open",
	"pairing",
	"allowlist"
]);
const GroupPolicySchema = z$1.union([z$1.enum([
	"open",
	"allowlist",
	"disabled"
]), z$1.literal("allowall").transform(() => "open")]);
const FeishuDomainSchema = z$1.union([z$1.enum(["feishu", "lark"]), z$1.string().url().startsWith("https://")]);
const FeishuConnectionModeSchema = z$1.enum(["websocket", "webhook"]);
const ToolPolicySchema = z$1.object({
	allow: z$1.array(z$1.string()).optional(),
	deny: z$1.array(z$1.string()).optional()
}).strict().optional();
const DmConfigSchema = z$1.object({
	enabled: z$1.boolean().optional(),
	systemPrompt: z$1.string().optional()
}).strict().optional();
const MarkdownConfigSchema = z$1.object({
	mode: z$1.enum([
		"native",
		"escape",
		"strip"
	]).optional(),
	tableMode: z$1.enum([
		"native",
		"ascii",
		"simple"
	]).optional()
}).strict().optional();
const RenderModeSchema = z$1.enum([
	"auto",
	"raw",
	"card"
]).optional();
const StreamingModeSchema = z$1.boolean().optional();
const BlockStreamingCoalesceSchema = z$1.object({
	enabled: z$1.boolean().optional(),
	minDelayMs: z$1.number().int().positive().optional(),
	maxDelayMs: z$1.number().int().positive().optional()
}).strict().optional();
const ChannelHeartbeatVisibilitySchema = z$1.object({
	visibility: z$1.enum(["visible", "hidden"]).optional(),
	intervalMs: z$1.number().int().positive().optional()
}).strict().optional();
/**
* Dynamic agent creation configuration.
* When enabled, a new agent is created for each unique DM user.
*/
const DynamicAgentCreationSchema = z$1.object({
	enabled: z$1.boolean().optional(),
	workspaceTemplate: z$1.string().optional(),
	agentDirTemplate: z$1.string().optional(),
	maxAgents: z$1.number().int().positive().optional()
}).strict().optional();
/**
* Feishu tools configuration.
* Controls which tool categories are enabled.
*
* Dependencies:
* - wiki requires doc (wiki content is edited via doc tools)
* - perm can work independently but is typically used with drive
*/
const FeishuToolsConfigSchema = z$1.object({
	doc: z$1.boolean().optional(),
	chat: z$1.boolean().optional(),
	wiki: z$1.boolean().optional(),
	drive: z$1.boolean().optional(),
	perm: z$1.boolean().optional(),
	scopes: z$1.boolean().optional()
}).strict().optional();
/**
* Group session scope for routing Feishu group messages.
* - "group" (default): one session per group chat
* - "group_sender": one session per (group + sender)
* - "group_topic": one session per group topic thread (falls back to group if no topic)
* - "group_topic_sender": one session per (group + topic thread + sender),
*   falls back to (group + sender) if no topic
*/
const GroupSessionScopeSchema = z$1.enum([
	"group",
	"group_sender",
	"group_topic",
	"group_topic_sender"
]).optional();
/**
* @deprecated Use groupSessionScope instead.
*
* Topic session isolation mode for group chats.
* - "disabled" (default): All messages in a group share one session
* - "enabled": Messages in different topics get separate sessions
*
* Topic routing uses `root_id` when present to keep session continuity and
* falls back to `thread_id` when `root_id` is unavailable.
*/
const TopicSessionModeSchema = z$1.enum(["disabled", "enabled"]).optional();
const ReactionNotificationModeSchema = z$1.enum([
	"off",
	"own",
	"all"
]).optional();
/**
* Reply-in-thread mode for group chats.
* - "disabled" (default): Bot replies are normal inline replies
* - "enabled": Bot replies create or continue a Feishu topic thread
*
* When enabled, the Feishu reply API is called with `reply_in_thread: true`,
* causing the reply to appear as a topic (话题) under the original message.
*/
const ReplyInThreadSchema = z$1.enum(["disabled", "enabled"]).optional();
const FeishuGroupSchema = z$1.object({
	requireMention: z$1.boolean().optional(),
	tools: ToolPolicySchema,
	skills: z$1.array(z$1.string()).optional(),
	enabled: z$1.boolean().optional(),
	allowFrom: z$1.array(z$1.union([z$1.string(), z$1.number()])).optional(),
	systemPrompt: z$1.string().optional(),
	groupSessionScope: GroupSessionScopeSchema,
	topicSessionMode: TopicSessionModeSchema,
	replyInThread: ReplyInThreadSchema
}).strict();
const FeishuSharedConfigShape = {
	webhookHost: z$1.string().optional(),
	webhookPort: z$1.number().int().positive().optional(),
	capabilities: z$1.array(z$1.string()).optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z$1.boolean().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: z$1.array(z$1.union([z$1.string(), z$1.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional(),
	groupAllowFrom: z$1.array(z$1.union([z$1.string(), z$1.number()])).optional(),
	groupSenderAllowFrom: z$1.array(z$1.union([z$1.string(), z$1.number()])).optional(),
	requireMention: z$1.boolean().optional(),
	groups: z$1.record(z$1.string(), FeishuGroupSchema.optional()).optional(),
	historyLimit: z$1.number().int().min(0).optional(),
	dmHistoryLimit: z$1.number().int().min(0).optional(),
	dms: z$1.record(z$1.string(), DmConfigSchema).optional(),
	textChunkLimit: z$1.number().int().positive().optional(),
	chunkMode: z$1.enum(["length", "newline"]).optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema,
	mediaMaxMb: z$1.number().positive().optional(),
	httpTimeoutMs: z$1.number().int().positive().max(3e5).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	renderMode: RenderModeSchema,
	streaming: StreamingModeSchema,
	tools: FeishuToolsConfigSchema,
	actions: ChannelActionsSchema,
	replyInThread: ReplyInThreadSchema,
	reactionNotifications: ReactionNotificationModeSchema,
	typingIndicator: z$1.boolean().optional(),
	resolveSenderNames: z$1.boolean().optional()
};
/**
* Per-account configuration.
* All fields are optional - missing fields inherit from top-level config.
*/
const FeishuAccountConfigSchema = z$1.object({
	enabled: z$1.boolean().optional(),
	name: z$1.string().optional(),
	appId: z$1.string().optional(),
	appSecret: buildSecretInputSchema().optional(),
	encryptKey: buildSecretInputSchema().optional(),
	verificationToken: buildSecretInputSchema().optional(),
	domain: FeishuDomainSchema.optional(),
	connectionMode: FeishuConnectionModeSchema.optional(),
	webhookPath: z$1.string().optional(),
	...FeishuSharedConfigShape,
	groupSessionScope: GroupSessionScopeSchema,
	topicSessionMode: TopicSessionModeSchema
}).strict();
const FeishuConfigSchema = z$1.object({
	enabled: z$1.boolean().optional(),
	defaultAccount: z$1.string().optional(),
	appId: z$1.string().optional(),
	appSecret: buildSecretInputSchema().optional(),
	encryptKey: buildSecretInputSchema().optional(),
	verificationToken: buildSecretInputSchema().optional(),
	domain: FeishuDomainSchema.optional().default("feishu"),
	connectionMode: FeishuConnectionModeSchema.optional().default("websocket"),
	webhookPath: z$1.string().optional().default("/feishu/events"),
	...FeishuSharedConfigShape,
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	reactionNotifications: ReactionNotificationModeSchema.optional().default("own"),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	requireMention: z$1.boolean().optional().default(true),
	groupSessionScope: GroupSessionScopeSchema,
	topicSessionMode: TopicSessionModeSchema,
	dynamicAgentCreation: DynamicAgentCreationSchema,
	typingIndicator: z$1.boolean().optional().default(true),
	resolveSenderNames: z$1.boolean().optional().default(true),
	accounts: z$1.record(z$1.string(), FeishuAccountConfigSchema.optional()).optional()
}).strict().superRefine((value, ctx) => {
	const defaultAccount = value.defaultAccount?.trim();
	if (defaultAccount && value.accounts && Object.keys(value.accounts).length > 0) {
		const normalizedDefaultAccount = normalizeAccountId(defaultAccount);
		if (!Object.prototype.hasOwnProperty.call(value.accounts, normalizedDefaultAccount)) {ctx.addIssue({
			code: z$1.ZodIssueCode.custom,
			path: ["defaultAccount"],
			message: `channels.feishu.defaultAccount="${defaultAccount}" does not match a configured account key`
		});}
	}
	const defaultConnectionMode = value.connectionMode ?? "websocket";
	const defaultVerificationTokenConfigured = hasConfiguredSecretInput(value.verificationToken);
	const defaultEncryptKeyConfigured = hasConfiguredSecretInput(value.encryptKey);
	if (defaultConnectionMode === "webhook") {
		if (!defaultVerificationTokenConfigured) {ctx.addIssue({
			code: z$1.ZodIssueCode.custom,
			path: ["verificationToken"],
			message: "channels.feishu.connectionMode=\"webhook\" requires channels.feishu.verificationToken"
		});}
		if (!defaultEncryptKeyConfigured) {ctx.addIssue({
			code: z$1.ZodIssueCode.custom,
			path: ["encryptKey"],
			message: "channels.feishu.connectionMode=\"webhook\" requires channels.feishu.encryptKey"
		});}
	}
	for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
		if (!account) {continue;}
		if ((account.connectionMode ?? defaultConnectionMode) !== "webhook") {continue;}
		const accountVerificationTokenConfigured = hasConfiguredSecretInput(account.verificationToken) || defaultVerificationTokenConfigured;
		const accountEncryptKeyConfigured = hasConfiguredSecretInput(account.encryptKey) || defaultEncryptKeyConfigured;
		if (!accountVerificationTokenConfigured) {ctx.addIssue({
			code: z$1.ZodIssueCode.custom,
			path: [
				"accounts",
				accountId,
				"verificationToken"
			],
			message: `channels.feishu.accounts.${accountId}.connectionMode="webhook" requires a verificationToken (account-level or top-level)`
		});}
		if (!accountEncryptKeyConfigured) {ctx.addIssue({
			code: z$1.ZodIssueCode.custom,
			path: [
				"accounts",
				accountId,
				"encryptKey"
			],
			message: `channels.feishu.accounts.${accountId}.connectionMode="webhook" requires an encryptKey (account-level or top-level)`
		});}
	}
	if (value.dmPolicy === "open") {
		if (!(value.allowFrom ?? []).some((entry) => String(entry).trim() === "*")) {ctx.addIssue({
			code: z$1.ZodIssueCode.custom,
			path: ["allowFrom"],
			message: "channels.feishu.dmPolicy=\"open\" requires channels.feishu.allowFrom to include \"*\""
		});}
	}
});
//#endregion
//#region extensions/feishu/src/channel.ts
const meta = {
	id: "feishu",
	label: "Feishu",
	selectionLabel: "Feishu/Lark (飞书)",
	docsPath: "/channels/feishu",
	docsLabel: "feishu",
	blurb: "飞书/Lark enterprise messaging.",
	aliases: ["lark"],
	order: 70
};
async function loadFeishuChannelRuntime() {
	return await import("./channel.runtime-CyJNb46M.js");
}
function setFeishuNamedAccountEnabled(cfg, accountId, enabled) {
	const feishuCfg = cfg.channels?.feishu;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			feishu: {
				...feishuCfg,
				accounts: {
					...feishuCfg?.accounts,
					[accountId]: {
						...feishuCfg?.accounts?.[accountId],
						enabled
					}
				}
			}
		}
	};
}
function isFeishuReactionsActionEnabled(params) {
	if (!params.account.enabled || !params.account.configured) {return false;}
	return createActionGate(params.account.config.actions ?? (params.cfg.channels?.feishu)?.actions)("reactions");
}
function areAnyFeishuReactionActionsEnabled(cfg) {
	for (const account of listEnabledFeishuAccounts(cfg)) {if (isFeishuReactionsActionEnabled({
		cfg,
		account
	})) return true;}
	return false;
}
function isSupportedFeishuDirectConversationId(conversationId) {
	const trimmed = conversationId.trim();
	if (!trimmed || trimmed.includes(":")) {return false;}
	if (trimmed.startsWith("oc_") || trimmed.startsWith("on_")) {return false;}
	return true;
}
function normalizeFeishuAcpConversationId(conversationId) {
	const parsed = parseFeishuConversationId({ conversationId });
	if (!parsed || parsed.scope !== "group_topic" && parsed.scope !== "group_topic_sender" && !isSupportedFeishuDirectConversationId(parsed.canonicalConversationId)) {return null;}
	return {
		conversationId: parsed.canonicalConversationId,
		parentConversationId: parsed.scope === "group_topic" || parsed.scope === "group_topic_sender" ? parsed.chatId : void 0
	};
}
function matchFeishuAcpConversation(params) {
	const binding = normalizeFeishuAcpConversationId(params.bindingConversationId);
	if (!binding) {return null;}
	const incoming = parseFeishuConversationId({
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (!incoming || incoming.scope !== "group_topic" && incoming.scope !== "group_topic_sender" && !isSupportedFeishuDirectConversationId(incoming.canonicalConversationId)) {return null;}
	const matchesCanonicalConversation = binding.conversationId === incoming.canonicalConversationId;
	const matchesParentTopicForSenderScopedConversation = incoming.scope === "group_topic_sender" && binding.parentConversationId === incoming.chatId && binding.conversationId === `${incoming.chatId}:topic:${incoming.topicId}`;
	if (!matchesCanonicalConversation && !matchesParentTopicForSenderScopedConversation) {return null;}
	return {
		conversationId: matchesParentTopicForSenderScopedConversation ? binding.conversationId : incoming.canonicalConversationId,
		parentConversationId: incoming.scope === "group_topic" || incoming.scope === "group_topic_sender" ? incoming.chatId : void 0,
		matchPriority: matchesCanonicalConversation ? 2 : 1
	};
}
function jsonActionResult(details) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(details)
		}],
		details
	};
}
function readFirstString(params, keys, fallback) {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim()) {return value.trim();}
	}
	if (typeof fallback === "string" && fallback.trim()) {return fallback.trim();}
}
function readOptionalNumber(params, keys) {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "number" && Number.isFinite(value)) {return value;}
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {return parsed;}
		}
	}
}
function resolveFeishuActionTarget(ctx) {
	return readFirstString(ctx.params, ["to", "target"], ctx.toolContext?.currentChannelId);
}
function resolveFeishuChatId(ctx) {
	const raw = readFirstString(ctx.params, [
		"chatId",
		"chat_id",
		"channelId",
		"channel_id",
		"to",
		"target"
	], ctx.toolContext?.currentChannelId);
	if (!raw) {return;}
	if (/^(user|dm|open_id):/i.test(raw)) {return;}
	if (/^(chat|group|channel):/i.test(raw)) {return normalizeFeishuTarget(raw) ?? void 0;}
	return raw;
}
function resolveFeishuMessageId(params) {
	return readFirstString(params, [
		"messageId",
		"message_id",
		"replyTo",
		"reply_to"
	]);
}
function resolveFeishuMemberId(params) {
	return readFirstString(params, [
		"memberId",
		"member_id",
		"userId",
		"user_id",
		"openId",
		"open_id",
		"unionId",
		"union_id"
	]);
}
function resolveFeishuMemberIdType(params) {
	const raw = readFirstString(params, [
		"memberIdType",
		"member_id_type",
		"userIdType",
		"user_id_type"
	]);
	if (raw === "open_id" || raw === "user_id" || raw === "union_id") {return raw;}
	if (readFirstString(params, ["userId", "user_id"]) && !readFirstString(params, [
		"openId",
		"open_id",
		"unionId",
		"union_id"
	])) {return "user_id";}
	if (readFirstString(params, ["unionId", "union_id"]) && !readFirstString(params, ["openId", "open_id"])) {return "union_id";}
	return "open_id";
}
const feishuPlugin = {
	id: "feishu",
	meta: { ...meta },
	pairing: {
		idLabel: "feishuUserId",
		normalizeAllowEntry: (entry) => entry.replace(/^(feishu|user|open_id):/i, ""),
		notifyApproval: async ({ cfg, id }) => {
			const { sendMessageFeishu } = await loadFeishuChannelRuntime();
			await sendMessageFeishu({
				cfg,
				to: id,
				text: PAIRING_APPROVED_MESSAGE
			});
		}
	},
	capabilities: {
		chatTypes: ["direct", "channel"],
		polls: false,
		threads: true,
		media: true,
		reactions: true,
		edit: true,
		reply: true
	},
	agentPrompt: { messageToolHints: () => [
		"- Feishu targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:open_id` or `chat:chat_id`.",
		"- Feishu supports interactive cards plus native image, file, audio, and video/media delivery.",
		"- Feishu supports `send`, `read`, `edit`, `thread-reply`, pins, and channel/member lookup, plus reactions when enabled."
	] },
	groups: { resolveToolPolicy: resolveFeishuGroupToolPolicy },
	mentions: { stripPatterns: () => ["<at user_id=\"[^\"]*\">[^<]*</at>"] },
	reload: { configPrefixes: ["channels.feishu"] },
	configSchema: buildChannelConfigSchema(FeishuConfigSchema),
	config: {
		listAccountIds: (cfg) => listFeishuAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveFeishuAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => {
			resolveFeishuAccount({
				cfg,
				accountId
			});
			if (accountId === "default") {return {
				...cfg,
				channels: {
					...cfg.channels,
					feishu: {
						...cfg.channels?.feishu,
						enabled
					}
				}
			};}
			return setFeishuNamedAccountEnabled(cfg, accountId, enabled);
		},
		deleteAccount: ({ cfg, accountId }) => {
			if (accountId === "default") {
				const next = { ...cfg };
				const nextChannels = { ...cfg.channels };
				delete nextChannels.feishu;
				if (Object.keys(nextChannels).length > 0) {next.channels = nextChannels;}
				else {delete next.channels;}
				return next;
			}
			const feishuCfg = cfg.channels?.feishu;
			const accounts = { ...feishuCfg?.accounts };
			delete accounts[accountId];
			return {
				...cfg,
				channels: {
					...cfg.channels,
					feishu: {
						...feishuCfg,
						accounts: Object.keys(accounts).length > 0 ? accounts : void 0
					}
				}
			};
		},
		isConfigured: (account) => account.configured,
		describeAccount: (account) => ({
			accountId: account.accountId,
			enabled: account.enabled,
			configured: account.configured,
			name: account.name,
			appId: account.appId,
			domain: account.domain
		}),
		resolveAllowFrom: ({ cfg, accountId }) => {
			return mapAllowFromEntries(resolveFeishuAccount({
				cfg,
				accountId
			}).config?.allowFrom);
		},
		formatAllowFrom: ({ allowFrom }) => formatAllowFromLowercase({ allowFrom })
	},
	actions: {
		listActions: ({ cfg }) => {
			if (listEnabledFeishuAccounts(cfg).length === 0) {return [];}
			const actions = new Set([
				"send",
				"read",
				"edit",
				"thread-reply",
				"pin",
				"list-pins",
				"unpin",
				"member-info",
				"channel-info",
				"channel-list"
			]);
			if (areAnyFeishuReactionActionsEnabled(cfg)) {
				actions.add("react");
				actions.add("reactions");
			}
			return Array.from(actions);
		},
		getCapabilities: ({ cfg }) => {
			return cfg.channels?.feishu?.enabled !== false && Boolean(resolveFeishuCredentials(cfg.channels?.feishu)) ? ["cards"] : [];
		},
		handleAction: async (ctx) => {
			const account = resolveFeishuAccount({
				cfg: ctx.cfg,
				accountId: ctx.accountId ?? void 0
			});
			if ((ctx.action === "react" || ctx.action === "reactions") && !isFeishuReactionsActionEnabled({
				cfg: ctx.cfg,
				account
			})) {throw new Error("Feishu reactions are disabled via actions.reactions.");}
			if (ctx.action === "send" || ctx.action === "thread-reply") {
				const to = resolveFeishuActionTarget(ctx);
				if (!to) {throw new Error(`Feishu ${ctx.action} requires a target (to).`);}
				const replyToMessageId = ctx.action === "thread-reply" ? resolveFeishuMessageId(ctx.params) : void 0;
				if (ctx.action === "thread-reply" && !replyToMessageId) {throw new Error("Feishu thread-reply requires messageId.");}
				const card = ctx.params.card && typeof ctx.params.card === "object" ? ctx.params.card : void 0;
				const text = readFirstString(ctx.params, ["text", "message"]);
				if (!card && !text) {throw new Error(`Feishu ${ctx.action} requires text/message or card.`);}
				const runtime = await loadFeishuChannelRuntime();
				const result = card ? await runtime.sendCardFeishu({
					cfg: ctx.cfg,
					to,
					card,
					accountId: ctx.accountId ?? void 0,
					replyToMessageId,
					replyInThread: ctx.action === "thread-reply"
				}) : await runtime.sendMessageFeishu({
					cfg: ctx.cfg,
					to,
					text,
					accountId: ctx.accountId ?? void 0,
					replyToMessageId,
					replyInThread: ctx.action === "thread-reply"
				});
				return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: ctx.action,
					...result
				});
			}
			if (ctx.action === "read") {
				const messageId = resolveFeishuMessageId(ctx.params);
				if (!messageId) {throw new Error("Feishu read requires messageId.");}
				const { getMessageFeishu } = await loadFeishuChannelRuntime();
				const message = await getMessageFeishu({
					cfg: ctx.cfg,
					messageId,
					accountId: ctx.accountId ?? void 0
				});
				if (!message) {return {
					isError: true,
					content: [{
						type: "text",
						text: JSON.stringify({ error: `Feishu read failed or message not found: ${messageId}` })
					}],
					details: { error: `Feishu read failed or message not found: ${messageId}` }
				};}
				return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "read",
					message
				});
			}
			if (ctx.action === "edit") {
				const messageId = resolveFeishuMessageId(ctx.params);
				if (!messageId) {throw new Error("Feishu edit requires messageId.");}
				const text = readFirstString(ctx.params, ["text", "message"]);
				const card = ctx.params.card && typeof ctx.params.card === "object" ? ctx.params.card : void 0;
				const { editMessageFeishu } = await loadFeishuChannelRuntime();
				return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "edit",
					...await editMessageFeishu({
						cfg: ctx.cfg,
						messageId,
						text,
						card,
						accountId: ctx.accountId ?? void 0
					})
				});
			}
			if (ctx.action === "pin") {
				const messageId = resolveFeishuMessageId(ctx.params);
				if (!messageId) {throw new Error("Feishu pin requires messageId.");}
				const { createPinFeishu } = await loadFeishuChannelRuntime();
				return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "pin",
					pin: await createPinFeishu({
						cfg: ctx.cfg,
						messageId,
						accountId: ctx.accountId ?? void 0
					})
				});
			}
			if (ctx.action === "unpin") {
				const messageId = resolveFeishuMessageId(ctx.params);
				if (!messageId) {throw new Error("Feishu unpin requires messageId.");}
				const { removePinFeishu } = await loadFeishuChannelRuntime();
				await removePinFeishu({
					cfg: ctx.cfg,
					messageId,
					accountId: ctx.accountId ?? void 0
				});
				return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "unpin",
					messageId
				});
			}
			if (ctx.action === "list-pins") {
				const chatId = resolveFeishuChatId(ctx);
				if (!chatId) {throw new Error("Feishu list-pins requires chatId or channelId.");}
				const { listPinsFeishu } = await loadFeishuChannelRuntime();
				return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "list-pins",
					...await listPinsFeishu({
						cfg: ctx.cfg,
						chatId,
						startTime: readFirstString(ctx.params, ["startTime", "start_time"]),
						endTime: readFirstString(ctx.params, ["endTime", "end_time"]),
						pageSize: readOptionalNumber(ctx.params, ["pageSize", "page_size"]),
						pageToken: readFirstString(ctx.params, ["pageToken", "page_token"]),
						accountId: ctx.accountId ?? void 0
					})
				});
			}
			if (ctx.action === "channel-info") {
				const chatId = resolveFeishuChatId(ctx);
				if (!chatId) {throw new Error("Feishu channel-info requires chatId or channelId.");}
				const runtime = await loadFeishuChannelRuntime();
				const client = createFeishuClient(account);
				const channel = await runtime.getChatInfo(client, chatId);
				if (!(ctx.params.includeMembers === true || ctx.params.members === true)) {return jsonActionResult({
					ok: true,
					provider: "feishu",
					action: "channel-info",
					channel
				});}
				return jsonActionResult({
					ok: true,
					provider: "feishu",
					action: "channel-info",
					channel,
					members: await runtime.getChatMembers(client, chatId, readOptionalNumber(ctx.params, ["pageSize", "page_size"]), readFirstString(ctx.params, ["pageToken", "page_token"]), resolveFeishuMemberIdType(ctx.params))
				});
			}
			if (ctx.action === "member-info") {
				const runtime = await loadFeishuChannelRuntime();
				const client = createFeishuClient(account);
				const memberId = resolveFeishuMemberId(ctx.params);
				if (memberId) {return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "member-info",
					member: await runtime.getFeishuMemberInfo(client, memberId, resolveFeishuMemberIdType(ctx.params))
				});}
				const chatId = resolveFeishuChatId(ctx);
				if (!chatId) {throw new Error("Feishu member-info requires memberId or chatId/channelId.");}
				return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "member-info",
					...await runtime.getChatMembers(client, chatId, readOptionalNumber(ctx.params, ["pageSize", "page_size"]), readFirstString(ctx.params, ["pageToken", "page_token"]), resolveFeishuMemberIdType(ctx.params))
				});
			}
			if (ctx.action === "channel-list") {
				const runtime = await loadFeishuChannelRuntime();
				const query = readFirstString(ctx.params, ["query"]);
				const limit = readOptionalNumber(ctx.params, ["limit"]);
				const scope = readFirstString(ctx.params, ["scope", "kind"]) ?? "all";
				if (scope === "groups" || scope === "group" || scope === "channels" || scope === "channel") {return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "channel-list",
					groups: await runtime.listFeishuDirectoryGroupsLive({
						cfg: ctx.cfg,
						query,
						limit,
						fallbackToStatic: false,
						accountId: ctx.accountId ?? void 0
					})
				});}
				if (scope === "peers" || scope === "peer" || scope === "members" || scope === "member" || scope === "users" || scope === "user") {return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "channel-list",
					peers: await runtime.listFeishuDirectoryPeersLive({
						cfg: ctx.cfg,
						query,
						limit,
						fallbackToStatic: false,
						accountId: ctx.accountId ?? void 0
					})
				});}
				const [groups, peers] = await Promise.all([runtime.listFeishuDirectoryGroupsLive({
					cfg: ctx.cfg,
					query,
					limit,
					fallbackToStatic: false,
					accountId: ctx.accountId ?? void 0
				}), runtime.listFeishuDirectoryPeersLive({
					cfg: ctx.cfg,
					query,
					limit,
					fallbackToStatic: false,
					accountId: ctx.accountId ?? void 0
				})]);
				return jsonActionResult({
					ok: true,
					channel: "feishu",
					action: "channel-list",
					groups,
					peers
				});
			}
			if (ctx.action === "react") {
				const messageId = resolveFeishuMessageId(ctx.params);
				if (!messageId) {throw new Error("Feishu reaction requires messageId.");}
				const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
				const remove = ctx.params.remove === true;
				const clearAll = ctx.params.clearAll === true;
				if (remove) {
					if (!emoji) {throw new Error("Emoji is required to remove a Feishu reaction.");}
					const { listReactionsFeishu, removeReactionFeishu } = await loadFeishuChannelRuntime();
					const ownReaction = (await listReactionsFeishu({
						cfg: ctx.cfg,
						messageId,
						emojiType: emoji,
						accountId: ctx.accountId ?? void 0
					})).find((entry) => entry.operatorType === "app");
					if (!ownReaction) {return jsonActionResult({
						ok: true,
						removed: null
					});}
					await removeReactionFeishu({
						cfg: ctx.cfg,
						messageId,
						reactionId: ownReaction.reactionId,
						accountId: ctx.accountId ?? void 0
					});
					return jsonActionResult({
						ok: true,
						removed: emoji
					});
				}
				if (!emoji) {
					if (!clearAll) {throw new Error("Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.");}
					const { listReactionsFeishu, removeReactionFeishu } = await loadFeishuChannelRuntime();
					const reactions = await listReactionsFeishu({
						cfg: ctx.cfg,
						messageId,
						accountId: ctx.accountId ?? void 0
					});
					let removed = 0;
					for (const reaction of reactions.filter((entry) => entry.operatorType === "app")) {
						await removeReactionFeishu({
							cfg: ctx.cfg,
							messageId,
							reactionId: reaction.reactionId,
							accountId: ctx.accountId ?? void 0
						});
						removed += 1;
					}
					return jsonActionResult({
						ok: true,
						removed
					});
				}
				const { addReactionFeishu } = await loadFeishuChannelRuntime();
				await addReactionFeishu({
					cfg: ctx.cfg,
					messageId,
					emojiType: emoji,
					accountId: ctx.accountId ?? void 0
				});
				return jsonActionResult({
					ok: true,
					added: emoji
				});
			}
			if (ctx.action === "reactions") {
				const messageId = resolveFeishuMessageId(ctx.params);
				if (!messageId) {throw new Error("Feishu reactions lookup requires messageId.");}
				const { listReactionsFeishu } = await loadFeishuChannelRuntime();
				return jsonActionResult({
					ok: true,
					reactions: await listReactionsFeishu({
						cfg: ctx.cfg,
						messageId,
						accountId: ctx.accountId ?? void 0
					})
				});
			}
			throw new Error(`Unsupported Feishu action: "${String(ctx.action)}"`);
		}
	},
	security: { collectWarnings: ({ cfg, accountId }) => {
		const account = resolveFeishuAccount({
			cfg,
			accountId
		});
		const feishuCfg = account.config;
		return collectAllowlistProviderRestrictSendersWarnings({
			cfg,
			providerConfigPresent: cfg.channels?.feishu !== void 0,
			configuredGroupPolicy: feishuCfg?.groupPolicy,
			surface: `Feishu[${account.accountId}] groups`,
			openScope: "any member",
			groupPolicyPath: "channels.feishu.groupPolicy",
			groupAllowFromPath: "channels.feishu.groupAllowFrom"
		});
	} },
	acpBindings: {
		normalizeConfiguredBindingTarget: ({ conversationId }) => normalizeFeishuAcpConversationId(conversationId),
		matchConfiguredBinding: ({ bindingConversationId, conversationId, parentConversationId }) => matchFeishuAcpConversation({
			bindingConversationId,
			conversationId,
			parentConversationId
		})
	},
	setup: feishuSetupAdapter,
	setupWizard: feishuSetupWizard,
	messaging: {
		normalizeTarget: (raw) => normalizeFeishuTarget(raw) ?? void 0,
		targetResolver: {
			looksLikeId: looksLikeFeishuId,
			hint: "<chatId|user:openId|chat:chatId>"
		}
	},
	directory: {
		self: async () => null,
		listPeers: async ({ cfg, query, limit, accountId }) => listFeishuDirectoryPeers({
			cfg,
			query: query ?? void 0,
			limit: limit ?? void 0,
			accountId: accountId ?? void 0
		}),
		listGroups: async ({ cfg, query, limit, accountId }) => listFeishuDirectoryGroups({
			cfg,
			query: query ?? void 0,
			limit: limit ?? void 0,
			accountId: accountId ?? void 0
		}),
		listPeersLive: async ({ cfg, query, limit, accountId }) => (await loadFeishuChannelRuntime()).listFeishuDirectoryPeersLive({
			cfg,
			query: query ?? void 0,
			limit: limit ?? void 0,
			accountId: accountId ?? void 0
		}),
		listGroupsLive: async ({ cfg, query, limit, accountId }) => (await loadFeishuChannelRuntime()).listFeishuDirectoryGroupsLive({
			cfg,
			query: query ?? void 0,
			limit: limit ?? void 0,
			accountId: accountId ?? void 0
		})
	},
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		sendText: async (params) => (await loadFeishuChannelRuntime()).feishuOutbound.sendText(params),
		sendMedia: async (params) => (await loadFeishuChannelRuntime()).feishuOutbound.sendMedia(params)
	},
	status: {
		defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
		buildChannelSummary: ({ snapshot }) => buildProbeChannelStatusSummary(snapshot, { port: snapshot.port ?? null }),
		probeAccount: async ({ account }) => await (await loadFeishuChannelRuntime()).probeFeishu(account),
		buildAccountSnapshot: ({ account, runtime, probe }) => ({
			accountId: account.accountId,
			enabled: account.enabled,
			configured: account.configured,
			name: account.name,
			appId: account.appId,
			domain: account.domain,
			...buildRuntimeAccountStatusSnapshot({
				runtime,
				probe
			}),
			port: runtime?.port ?? null
		})
	},
	gateway: { startAccount: async (ctx) => {
		const { monitorFeishuProvider } = await import("./monitor-Bn_WUqiB.js").then((n) => n.n);
		const account = resolveFeishuAccount({
			cfg: ctx.cfg,
			accountId: ctx.accountId
		});
		const port = account.config?.webhookPort ?? null;
		ctx.setStatus({
			accountId: ctx.accountId,
			port
		});
		ctx.log?.info(`starting feishu[${ctx.accountId}] (mode: ${account.config?.connectionMode ?? "websocket"})`);
		return monitorFeishuProvider({
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			accountId: ctx.accountId
		});
	} }
};
//#endregion
export { feishuPlugin as t };
