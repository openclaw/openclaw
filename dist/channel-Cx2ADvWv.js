import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { At as boolean, Et as array, Nn as record, Rn as string, Tn as object, Xn as union, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { n as ZodIssueCode } from "./compat-bCpUj7Jq.js";
import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { f as renderMessagePresentationFallbackText, l as normalizeMessagePresentation } from "./payload-BDV15CYA.js";
import { i as createLazyRuntimeNamedExport } from "./lazy-runtime-D-7_JraP.js";
import { i as createActionGate } from "./common-E9YpX7pB.js";
import { i as createHybridChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-xZ4-bv2H.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as describeAccountSnapshot } from "./account-helpers-BEXOONiv.js";
import { i as createChatChannelPlugin, t as buildChannelOutboundSessionRoute, u as stripChannelTargetPrefix } from "./core-kXuNbs5U.js";
import "./channel-core-CV-k5W6W.js";
import { r as buildSecretInputSchema } from "./secret-input-CWnTb0tw.js";
import { t as formatAllowFromLowercase } from "./allow-from-CvE3rvhy.js";
import { E as projectConfigAccountIdWarningCollector, g as createAllowlistProviderGroupPolicyWarningCollector } from "./channel-policy-pv8ZpZxj.js";
import { t as createChannelDirectoryAdapter } from "./directory-runtime-wFQhDUBI.js";
import { n as createRuntimeOutboundDelegates, t as createRuntimeDirectoryLiveAdapter } from "./runtime-forwarders-CJHIfxll.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { D as patchTopLevelChannelConfigSection, P as promptSingleChannelSecretInput, Q as splitSetupEntries, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-DPvocg6M.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-BaAy3FfF.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-dxinAe5Y.js";
import "./outbound-runtime-CGgaScW3.js";
import "./conversation-runtime-guwDSNIo.js";
import { t as chunkTextForOutbound } from "./text-chunking-C154U6-i.js";
import "./account-resolution-Dy8RKAMt.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./pairing-message-C9w9gv4K.js";
import { d as createDefaultChannelRuntimeState, i as buildProbeChannelStatusSummary, u as createComputedAccountStatusAdapter } from "./status-helpers-CnvYAK73.js";
import "./channel-status-pVVcmlap.js";
import "./channel-config-primitives-BKu_-glE.js";
import "./channel-actions-DMN7G5RZ.js";
import { r as defineChannelMessageAdapter } from "./channel-message-DMGbyII_.js";
import { i as createPairingPrefixStripper } from "./channel-pairing-N4dBc-K-.js";
import { a as parseFeishuTargetId, i as parseFeishuDirectConversationId, n as buildFeishuModelOverrideParentCandidates, r as parseFeishuConversationId, t as buildFeishuConversationId } from "./conversation-id-Cp5_uafu.js";
import { n as looksLikeFeishuId, r as normalizeFeishuTarget } from "./targets-BVM6OB3d.js";
import { a as resolveDefaultFeishuAccountId, i as listFeishuAccountIds, l as resolveFeishuRuntimeAccount, m as isRecord, n as inspectFeishuCredentials, r as listEnabledFeishuAccounts, s as resolveFeishuAccount } from "./accounts-Djfj3q-S.js";
import { n as createFeishuSendReceipt } from "./send-result-D6azRnOt.js";
import { n as listFeishuDirectoryPeers, t as listFeishuDirectoryGroups } from "./directory.static-D6j7UthR.js";
import { t as messageActionTargetAliases } from "./security-audit-DBDtT-IZ.js";
import { s as resolveFeishuGroupToolPolicy } from "./policy-Df2RfNIl.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "./secret-contract-CVNzdxbm.js";
import { t as collectFeishuSecurityAuditFindings } from "./security-audit-shared-BSMWTmTX.js";
import { t as resolveFeishuSessionConversation } from "./session-conversation-q8-78fEc.js";
//#region extensions/feishu/src/approval-auth.ts
function normalizeFeishuApproverId(value) {
	const trimmed = normalizeOptionalLowercaseString(normalizeFeishuTarget(String(value)));
	return trimmed?.startsWith("ou_") ? trimmed : void 0;
}
const feishuApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Feishu",
	resolveApprovers: ({ cfg, accountId }) => {
		const account = resolveFeishuAccount({
			cfg,
			accountId
		}).config;
		return resolveApprovalApprovers({
			allowFrom: account.allowFrom,
			normalizeApprover: normalizeFeishuApproverId
		});
	},
	normalizeSenderId: (value) => normalizeFeishuApproverId(value)
});
//#endregion
//#region extensions/feishu/src/config-schema.ts
const ChannelActionsSchema = object({ reactions: boolean().optional() }).strict().optional();
const DmPolicySchema = _enum([
	"open",
	"pairing",
	"allowlist"
]);
const GroupPolicySchema = union([_enum([
	"open",
	"allowlist",
	"disabled"
]), literal("allowall").transform(() => "open")]);
const FeishuDomainSchema = union([_enum(["feishu", "lark"]), string().url().startsWith("https://")]);
const FeishuConnectionModeSchema = _enum(["websocket", "webhook"]);
const TtsOverrideSchema = object({
	auto: _enum([
		"off",
		"always",
		"inbound",
		"tagged"
	]).optional(),
	enabled: boolean().optional(),
	mode: _enum(["final", "all"]).optional(),
	provider: string().optional(),
	persona: string().optional(),
	personas: record(string(), record(string(), unknown())).optional(),
	summaryModel: string().optional(),
	modelOverrides: record(string(), unknown()).optional(),
	providers: record(string(), record(string(), unknown())).optional(),
	prefsPath: string().optional(),
	maxTextLength: number().int().min(1).optional(),
	timeoutMs: number().int().min(1e3).max(12e4).optional()
}).strict().optional();
const ToolPolicySchema = object({
	allow: array(string()).optional(),
	deny: array(string()).optional()
}).strict().optional();
const DmConfigSchema = object({
	enabled: boolean().optional(),
	systemPrompt: string().optional()
}).strict().optional();
const MarkdownConfigSchema = object({
	mode: _enum([
		"native",
		"escape",
		"strip"
	]).optional(),
	tableMode: _enum([
		"native",
		"ascii",
		"simple"
	]).optional()
}).strict().optional();
const RenderModeSchema = _enum([
	"auto",
	"raw",
	"card"
]).optional();
const StreamingModeSchema = boolean().optional();
const BlockStreamingSchema = boolean().optional();
const BlockStreamingCoalesceSchema = object({
	enabled: boolean().optional(),
	minDelayMs: number().int().positive().optional(),
	maxDelayMs: number().int().positive().optional()
}).strict().optional();
const ChannelHeartbeatVisibilitySchema = object({
	visibility: _enum(["visible", "hidden"]).optional(),
	intervalMs: number().int().positive().optional()
}).strict().optional();
/**
* Dynamic agent creation configuration.
* When enabled, a new agent is created for each unique DM user.
*/
const DynamicAgentCreationSchema = object({
	enabled: boolean().optional(),
	workspaceTemplate: string().optional(),
	agentDirTemplate: string().optional(),
	maxAgents: number().int().positive().optional()
}).strict().optional();
/**
* Feishu tools configuration.
* Controls which tool categories are enabled.
*
* Dependencies:
* - wiki requires doc (wiki content is edited via doc tools)
* - perm can work independently but is typically used with drive
*/
const FeishuToolsConfigSchema = object({
	doc: boolean().optional(),
	chat: boolean().optional(),
	wiki: boolean().optional(),
	drive: boolean().optional(),
	perm: boolean().optional(),
	scopes: boolean().optional()
}).strict().optional();
/**
* Group session scope for routing Feishu group messages.
* - "group" (default): one session per group chat
* - "group_sender": one session per (group + sender)
* - "group_topic": one session per group topic thread (falls back to group if no topic)
* - "group_topic_sender": one session per (group + topic thread + sender),
*   falls back to (group + sender) if no topic
*/
const GroupSessionScopeSchema = _enum([
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
* Topic routing uses Feishu topic-group `thread_id` when the event identifies a
* native topic group, and keeps `root_id` precedence for normal groups so
* reply-created threads stay on the initiating message session.
*/
const TopicSessionModeSchema = _enum(["disabled", "enabled"]).optional();
const ReactionNotificationModeSchema = _enum([
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
const ReplyInThreadSchema = _enum(["disabled", "enabled"]).optional();
const FeishuGroupSchema = object({
	requireMention: boolean().optional(),
	tools: ToolPolicySchema,
	skills: array(string()).optional(),
	enabled: boolean().optional(),
	allowFrom: array(union([string(), number()])).optional(),
	systemPrompt: string().optional(),
	groupSessionScope: GroupSessionScopeSchema,
	topicSessionMode: TopicSessionModeSchema,
	replyInThread: ReplyInThreadSchema
}).strict();
const FeishuSharedConfigShape = {
	webhookHost: string().optional(),
	webhookPort: number().int().positive().optional(),
	capabilities: array(string()).optional(),
	markdown: MarkdownConfigSchema,
	configWrites: boolean().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: array(union([string(), number()])).optional(),
	groupPolicy: GroupPolicySchema.optional(),
	groupAllowFrom: array(union([string(), number()])).optional(),
	groupSenderAllowFrom: array(union([string(), number()])).optional(),
	requireMention: boolean().optional(),
	groups: record(string(), FeishuGroupSchema.optional()).optional(),
	historyLimit: number().int().min(0).optional(),
	dmHistoryLimit: number().int().min(0).optional(),
	dms: record(string(), DmConfigSchema).optional(),
	textChunkLimit: number().int().positive().optional(),
	chunkMode: _enum(["length", "newline"]).optional(),
	blockStreaming: BlockStreamingSchema,
	blockStreamingCoalesce: BlockStreamingCoalesceSchema,
	mediaMaxMb: number().positive().optional(),
	httpTimeoutMs: number().int().positive().max(3e5).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	renderMode: RenderModeSchema,
	streaming: StreamingModeSchema,
	tools: FeishuToolsConfigSchema,
	actions: ChannelActionsSchema,
	replyInThread: ReplyInThreadSchema,
	reactionNotifications: ReactionNotificationModeSchema,
	typingIndicator: boolean().optional(),
	resolveSenderNames: boolean().optional(),
	tts: TtsOverrideSchema
};
/**
* Per-account configuration.
* All fields are optional - missing fields inherit from top-level config.
*/
const FeishuAccountConfigSchema = object({
	enabled: boolean().optional(),
	name: string().optional(),
	appId: string().optional(),
	appSecret: buildSecretInputSchema().optional(),
	encryptKey: buildSecretInputSchema().optional(),
	verificationToken: buildSecretInputSchema().optional(),
	domain: FeishuDomainSchema.optional(),
	connectionMode: FeishuConnectionModeSchema.optional(),
	webhookPath: string().optional(),
	...FeishuSharedConfigShape,
	groupSessionScope: GroupSessionScopeSchema,
	topicSessionMode: TopicSessionModeSchema
}).strict();
const FeishuConfigSchema = object({
	enabled: boolean().optional(),
	defaultAccount: string().optional(),
	appId: string().optional(),
	appSecret: buildSecretInputSchema().optional(),
	encryptKey: buildSecretInputSchema().optional(),
	verificationToken: buildSecretInputSchema().optional(),
	domain: FeishuDomainSchema.optional().default("feishu"),
	connectionMode: FeishuConnectionModeSchema.optional().default("websocket"),
	webhookPath: string().optional().default("/feishu/events"),
	...FeishuSharedConfigShape,
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	reactionNotifications: ReactionNotificationModeSchema.optional().default("own"),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	requireMention: boolean().optional(),
	groupSessionScope: GroupSessionScopeSchema,
	topicSessionMode: TopicSessionModeSchema,
	dynamicAgentCreation: DynamicAgentCreationSchema,
	typingIndicator: boolean().optional().default(true),
	resolveSenderNames: boolean().optional().default(true),
	accounts: record(string(), FeishuAccountConfigSchema.optional()).optional()
}).strict().superRefine((value, ctx) => {
	const defaultAccount = value.defaultAccount?.trim();
	if (defaultAccount && value.accounts && Object.keys(value.accounts).length > 0) {
		const normalizedDefaultAccount = normalizeAccountId(defaultAccount);
		if (!Object.prototype.hasOwnProperty.call(value.accounts, normalizedDefaultAccount)) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: ["defaultAccount"],
			message: `channels.feishu.defaultAccount="${defaultAccount}" does not match a configured account key`
		});
	}
	const defaultConnectionMode = value.connectionMode ?? "websocket";
	const defaultVerificationTokenConfigured = hasConfiguredSecretInput(value.verificationToken);
	const defaultEncryptKeyConfigured = hasConfiguredSecretInput(value.encryptKey);
	if (defaultConnectionMode === "webhook") {
		if (!defaultVerificationTokenConfigured) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: ["verificationToken"],
			message: "channels.feishu.connectionMode=\"webhook\" requires channels.feishu.verificationToken"
		});
		if (!defaultEncryptKeyConfigured) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: ["encryptKey"],
			message: "channels.feishu.connectionMode=\"webhook\" requires channels.feishu.encryptKey"
		});
	}
	for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
		if (!account) continue;
		if ((account.connectionMode ?? defaultConnectionMode) !== "webhook") continue;
		const accountVerificationTokenConfigured = hasConfiguredSecretInput(account.verificationToken) || defaultVerificationTokenConfigured;
		const accountEncryptKeyConfigured = hasConfiguredSecretInput(account.encryptKey) || defaultEncryptKeyConfigured;
		if (!accountVerificationTokenConfigured) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: [
				"accounts",
				accountId,
				"verificationToken"
			],
			message: `channels.feishu.accounts.${accountId}.connectionMode="webhook" requires a verificationToken (account-level or top-level)`
		});
		if (!accountEncryptKeyConfigured) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: [
				"accounts",
				accountId,
				"encryptKey"
			],
			message: `channels.feishu.accounts.${accountId}.connectionMode="webhook" requires an encryptKey (account-level or top-level)`
		});
	}
	if (value.dmPolicy === "open") {
		if (!(value.allowFrom ?? []).some((entry) => String(entry).trim() === "*")) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: ["allowFrom"],
			message: "channels.feishu.dmPolicy=\"open\" requires channels.feishu.allowFrom to include \"*\""
		});
	}
});
//#endregion
//#region extensions/feishu/src/session-route.ts
function resolveFeishuOutboundSessionRoute(params) {
	let trimmed = stripChannelTargetPrefix(params.target, "feishu", "lark");
	if (!trimmed) return null;
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	let isGroup = false;
	let typeExplicit = false;
	if (lower.startsWith("group:") || lower.startsWith("chat:") || lower.startsWith("channel:")) {
		trimmed = trimmed.replace(/^(group|chat|channel):/i, "").trim();
		isGroup = true;
		typeExplicit = true;
	} else if (lower.startsWith("user:") || lower.startsWith("dm:")) {
		trimmed = trimmed.replace(/^(user|dm):/i, "").trim();
		isGroup = false;
		typeExplicit = true;
	}
	if (!typeExplicit) {
		const idLower = normalizeLowercaseStringOrEmpty(trimmed);
		if (idLower.startsWith("ou_") || idLower.startsWith("on_")) isGroup = false;
	}
	return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "feishu",
		accountId: params.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: trimmed
		},
		chatType: isGroup ? "group" : "direct",
		from: isGroup ? `feishu:group:${trimmed}` : `feishu:${trimmed}`,
		to: trimmed
	});
}
//#endregion
//#region extensions/feishu/src/setup-core.ts
function setFeishuNamedAccountEnabled$1(cfg, accountId, enabled) {
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
const feishuSetupAdapter = {
	resolveAccountId: ({ cfg, accountId }) => accountId?.trim() || resolveDefaultFeishuAccountId(cfg),
	applyAccountConfig: ({ cfg, accountId }) => {
		if (!accountId || accountId === "default") return {
			...cfg,
			channels: {
				...cfg.channels,
				feishu: {
					...cfg.channels?.feishu,
					enabled: true
				}
			}
		};
		return setFeishuNamedAccountEnabled$1(cfg, accountId, true);
	}
};
//#endregion
//#region extensions/feishu/src/setup-surface.ts
const t = createSetupTranslator();
const channel = "feishu";
const SCAN_TO_CREATE_TP = "ob_cli_app";
const FEISHU_SETUP_FLOW_KEY = "_flow";
function normalizeString(value) {
	if (typeof value !== "string") return;
	return value.trim() || void 0;
}
function isFeishuConfigured(cfg) {
	const feishuCfg = cfg.channels?.feishu;
	const isAppIdConfigured = (value) => {
		if (normalizeString(value)) return true;
		if (!value || typeof value !== "object") return false;
		const rec = value;
		const source = normalizeString(rec.source)?.toLowerCase();
		const id = normalizeString(rec.id);
		if (source === "env" && id) return Boolean(normalizeString(process.env[id]));
		return hasConfiguredSecretInput(value);
	};
	const topLevelConfigured = isAppIdConfigured(feishuCfg?.appId) && hasConfiguredSecretInput(feishuCfg?.appSecret);
	const accountConfigured = Object.values(feishuCfg?.accounts ?? {}).some((account) => {
		if (!account || typeof account !== "object") return false;
		const hasOwnAppId = Object.prototype.hasOwnProperty.call(account, "appId");
		const hasOwnAppSecret = Object.prototype.hasOwnProperty.call(account, "appSecret");
		const accountAppIdConfigured = hasOwnAppId ? isAppIdConfigured(account.appId) : isAppIdConfigured(feishuCfg?.appId);
		const accountSecretConfigured = hasOwnAppSecret ? hasConfiguredSecretInput(account.appSecret) : hasConfiguredSecretInput(feishuCfg?.appSecret);
		return accountAppIdConfigured && accountSecretConfigured;
	});
	return topLevelConfigured || accountConfigured;
}
function formatFeishuStatusLine(status) {
	if (status === "needs-credentials") return `Feishu: ${t("wizard.channels.statusNeedsAppCredentials")}`;
	return `Feishu: ${t("wizard.channels.statusConfiguredConnectionNotVerified")}`;
}
/**
* Patch feishu config at the correct location based on accountId.
* - DEFAULT_ACCOUNT_ID → writes to top-level channels.feishu
* - named account → writes to channels.feishu.accounts[accountId]
*/
function patchFeishuConfig(cfg, accountId, patch) {
	const feishuCfg = cfg.channels?.feishu;
	if (accountId === "default") return patchTopLevelChannelConfigSection({
		cfg,
		channel,
		enabled: true,
		patch
	});
	const nextAccountPatch = {
		...feishuCfg?.accounts?.[accountId],
		enabled: true,
		...patch
	};
	return patchTopLevelChannelConfigSection({
		cfg,
		channel,
		enabled: true,
		patch: { accounts: {
			...feishuCfg?.accounts,
			[accountId]: nextAccountPatch
		} }
	});
}
async function promptFeishuAllowFrom(params) {
	const feishuCfg = params.cfg.channels?.feishu;
	const resolvedAccountId = params.accountId ?? resolveDefaultFeishuAccountId(params.cfg);
	const existingAllowFrom = (resolvedAccountId !== "default" ? feishuCfg?.accounts?.[resolvedAccountId] : void 0)?.allowFrom ?? feishuCfg?.allowFrom ?? [];
	await params.prompter.note([
		t("wizard.feishu.allowlistIntro"),
		t("wizard.feishu.allowlistFindUser"),
		t("wizard.feishu.examples"),
		"- ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		"- on_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
	].join("\n"), t("wizard.feishu.allowlistTitle"));
	const mergedAllowFrom = mergeAllowFromEntries(existingAllowFrom, splitSetupEntries(await params.prompter.text({
		message: t("wizard.feishu.allowFromPrompt"),
		placeholder: "ou_xxxxx, ou_yyyyy",
		initialValue: existingAllowFrom.length > 0 ? existingAllowFrom.map(String).join(", ") : void 0
	})));
	return patchFeishuConfig(params.cfg, resolvedAccountId, { allowFrom: mergedAllowFrom });
}
async function noteFeishuCredentialHelp(prompter) {
	await prompter.note([
		t("wizard.feishu.credentialsStepOpenPlatform"),
		t("wizard.feishu.credentialsStepCreateApp"),
		t("wizard.feishu.credentialsStepGetCredentials"),
		t("wizard.feishu.credentialsStepPermissions"),
		t("wizard.feishu.credentialsStepPublish"),
		t("wizard.feishu.credentialsEnvTip"),
		t("wizard.channels.docs", { link: formatDocsLink("/channels/feishu", "feishu") })
	].join("\n"), t("wizard.feishu.credentialsTitle"));
}
async function promptFeishuAppId(params) {
	return (await params.prompter.text({
		message: t("wizard.feishu.appIdPrompt"),
		initialValue: params.initialValue,
		validate: (value) => value?.trim() ? void 0 : t("common.required")
	})).trim();
}
const feishuDmPolicy = {
	label: "Feishu",
	channel,
	policyKey: "channels.feishu.dmPolicy",
	allowFromKey: "channels.feishu.allowFrom",
	resolveConfigKeys: (_cfg, accountId) => {
		const resolvedAccountId = accountId ?? resolveDefaultFeishuAccountId(_cfg);
		return resolvedAccountId !== "default" ? {
			policyKey: `channels.feishu.accounts.${resolvedAccountId}.dmPolicy`,
			allowFromKey: `channels.feishu.accounts.${resolvedAccountId}.allowFrom`
		} : {
			policyKey: "channels.feishu.dmPolicy",
			allowFromKey: "channels.feishu.allowFrom"
		};
	},
	getCurrent: (cfg, accountId) => {
		const feishuCfg = cfg.channels?.feishu;
		const resolvedAccountId = accountId ?? resolveDefaultFeishuAccountId(cfg);
		if (resolvedAccountId !== "default") {
			const account = feishuCfg?.accounts?.[resolvedAccountId];
			if (account?.dmPolicy) return account.dmPolicy;
		}
		return feishuCfg?.dmPolicy ?? "pairing";
	},
	setPolicy: (cfg, policy, accountId) => {
		return patchFeishuConfig(cfg, accountId ?? resolveDefaultFeishuAccountId(cfg), {
			dmPolicy: policy,
			...policy === "open" ? { allowFrom: mergeAllowFromEntries([], ["*"]) } : {}
		});
	},
	promptAllowFrom: promptFeishuAllowFrom
};
function applyNewAppSecurityPolicy(cfg, accountId, openId, groupPolicy) {
	let next = cfg;
	if (openId) next = patchFeishuConfig(next, accountId, {
		dmPolicy: "allowlist",
		allowFrom: [openId]
	});
	const groupPatch = { groupPolicy };
	if (groupPolicy === "open") groupPatch.requireMention = true;
	next = patchFeishuConfig(next, accountId, groupPatch);
	return next;
}
async function promptFeishuDomain(params) {
	return await params.prompter.select({
		message: t("wizard.feishu.domainPrompt"),
		options: [{
			value: "feishu",
			label: t("wizard.feishu.domainFeishu")
		}, {
			value: "lark",
			label: t("wizard.feishu.domainLark")
		}],
		initialValue: params.initialValue ?? "feishu"
	});
}
async function promptFeishuSetupMethod(prompter) {
	return await prompter.select({
		message: t("wizard.feishu.setupMethodPrompt"),
		options: [{
			value: "manual",
			label: t("wizard.feishu.setupMethodManual")
		}, {
			value: "scan",
			label: t("wizard.feishu.setupMethodScan")
		}],
		initialValue: "manual"
	});
}
async function runScanToCreate(prompter, domain) {
	const { beginAppRegistration, initAppRegistration, pollAppRegistration, printQrCode } = await import("./app-registration-C2ffEZ1a.js");
	try {
		await initAppRegistration(domain);
	} catch {
		await prompter.note(t("wizard.feishu.scanUnavailable"), t("wizard.feishu.setupTitle"));
		return null;
	}
	const begin = await beginAppRegistration(domain);
	await prompter.note(t("wizard.feishu.scanQr"), t("wizard.feishu.scanTitle"));
	await printQrCode(begin.qrUrl);
	const progress = prompter.progress(t("wizard.feishu.fetchingConfig"));
	const outcome = await pollAppRegistration({
		deviceCode: begin.deviceCode,
		interval: begin.interval,
		expireIn: begin.expireIn,
		initialDomain: domain,
		tp: SCAN_TO_CREATE_TP
	});
	switch (outcome.status) {
		case "success":
			progress.stop(t("wizard.feishu.scanCompleted"));
			return outcome.result;
		case "access_denied":
			progress.stop(t("wizard.feishu.scanDenied"));
			return null;
		case "expired":
			progress.stop(t("wizard.feishu.scanExpired"));
			return null;
		case "timeout":
			progress.stop(t("wizard.feishu.scanTimedOut"));
			return null;
		case "error":
			progress.stop(t("wizard.feishu.scanError", { error: outcome.message }));
			return null;
	}
	return null;
}
async function runNewAppFlow(params) {
	const { prompter, options } = params;
	let next = params.cfg;
	const targetAccountId = resolveDefaultFeishuAccountId(next);
	let appId = null;
	let appSecret = null;
	let appSecretProbeValue = null;
	let scanDomain;
	let scanOpenId;
	const currentDomain = (next.channels?.feishu)?.domain ?? "feishu";
	const setupMethod = await promptFeishuSetupMethod(prompter);
	const selectedDomain = await promptFeishuDomain({
		prompter,
		initialValue: currentDomain
	});
	scanDomain = selectedDomain;
	const scanResult = setupMethod === "scan" ? await runScanToCreate(prompter, selectedDomain) : null;
	if (scanResult) {
		appId = scanResult.appId;
		appSecret = scanResult.appSecret;
		appSecretProbeValue = scanResult.appSecret;
		scanDomain = scanResult.domain;
		scanOpenId = scanResult.openId;
	} else {
		await noteFeishuCredentialHelp(prompter);
		appId = await promptFeishuAppId({
			prompter,
			initialValue: normalizeString(process.env.FEISHU_APP_ID)
		});
		const appSecretResult = await promptSingleChannelSecretInput({
			cfg: next,
			prompter,
			providerHint: "feishu",
			credentialLabel: "App Secret",
			secretInputMode: options?.secretInputMode,
			accountConfigured: false,
			canUseEnv: false,
			hasConfigToken: false,
			envPrompt: "",
			keepPrompt: t("wizard.feishu.appSecretKeep"),
			inputPrompt: t("wizard.feishu.appSecretPrompt"),
			preferredEnvVar: "FEISHU_APP_SECRET"
		});
		if (appSecretResult.action === "set") {
			appSecret = appSecretResult.value;
			appSecretProbeValue = appSecretResult.resolvedValue;
		}
		if (appId && appSecretProbeValue) {
			const { getAppOwnerOpenId } = await import("./app-registration-C2ffEZ1a.js");
			scanOpenId = await getAppOwnerOpenId({
				appId,
				appSecret: appSecretProbeValue,
				domain: selectedDomain
			});
		}
	}
	const groupPolicy = await prompter.select({
		message: t("wizard.feishu.groupPolicyPrompt"),
		options: [
			{
				value: "allowlist",
				label: t("wizard.feishu.groupPolicyAllowlist")
			},
			{
				value: "open",
				label: t("wizard.feishu.groupPolicyOpen")
			},
			{
				value: "disabled",
				label: t("wizard.feishu.groupPolicyDisabled")
			}
		],
		initialValue: "allowlist"
	});
	const configProgress = prompter.progress(t("wizard.feishu.configuring"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	if (appId && appSecret) next = patchFeishuConfig(next, targetAccountId, {
		appId,
		appSecret,
		connectionMode: "websocket",
		...scanDomain ? { domain: scanDomain } : {}
	});
	else if (scanDomain) next = patchFeishuConfig(next, targetAccountId, { domain: scanDomain });
	next = applyNewAppSecurityPolicy(next, targetAccountId, scanOpenId, groupPolicy);
	configProgress.stop(t("wizard.feishu.botConfigured"));
	return { cfg: next };
}
async function runEditFlow(params) {
	const { prompter, options } = params;
	const next = params.cfg;
	const feishuCfg = next.channels?.feishu;
	const resolveAppIdLabel = (value) => {
		const asString = normalizeString(value);
		if (asString) return asString;
		if (value && typeof value === "object") {
			const rec = value;
			if (normalizeString(rec.source) && normalizeString(rec.id)) return normalizeString(process.env[rec.id]) ?? `env:${String(rec.id)}`;
			if (hasConfiguredSecretInput(value)) return "(configured)";
		}
	};
	const existingAppId = resolveAppIdLabel(feishuCfg?.appId) ?? Object.values(feishuCfg?.accounts ?? {}).reduce((found, account) => {
		if (found) return found;
		if (account && typeof account === "object") return resolveAppIdLabel(account.appId);
	}, void 0);
	if (existingAppId) {
		if (!await prompter.confirm({
			message: t("wizard.feishu.existingBotPrompt", { appId: existingAppId }),
			initialValue: true
		})) return runNewAppFlow({
			cfg: next,
			prompter,
			options
		});
	} else return runNewAppFlow({
		cfg: next,
		prompter,
		options
	});
	await prompter.note(t("wizard.feishu.botConfigured"), "");
	return { cfg: next };
}
async function runFeishuLogin(params) {
	const { cfg, prompter } = params;
	const options = {};
	if (isFeishuConfigured(cfg)) {
		const result = await runEditFlow({
			cfg,
			prompter,
			options
		});
		if (result === null) return cfg;
		return result.cfg;
	}
	return (await runNewAppFlow({
		cfg,
		prompter,
		options
	})).cfg;
}
const feishuSetupWizard = {
	channel,
	resolveAccountIdForConfigure: ({ accountOverride, defaultAccountId, cfg }) => (typeof accountOverride === "string" && accountOverride.trim() ? accountOverride.trim() : void 0) ?? resolveDefaultFeishuAccountId(cfg) ?? defaultAccountId,
	resolveShouldPromptAccountIds: () => false,
	status: {
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsAppCredentials"),
		configuredHint: t("wizard.channels.statusConfigured"),
		unconfiguredHint: t("wizard.channels.statusNeedsAppCreds"),
		configuredScore: 2,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => isFeishuConfigured(cfg),
		resolveStatusLines: async ({ cfg, accountId, configured }) => {
			const account = resolveFeishuAccount({
				cfg,
				accountId
			});
			let probeResult = null;
			if (configured && account.configured) try {
				const { probeFeishu } = await import("./probe-Cwj0qkOR.js");
				probeResult = await probeFeishu(account);
			} catch {}
			if (!configured) return [formatFeishuStatusLine("needs-credentials")];
			if (probeResult?.ok) return [`Feishu: ${t("wizard.channels.statusConnectedAs", { name: probeResult.botName ?? probeResult.botOpenId ?? "bot" })}`];
			return [formatFeishuStatusLine("configured-unverified")];
		}
	},
	prepare: async ({ cfg, credentialValues }) => {
		if (isFeishuConfigured(cfg)) return { credentialValues: {
			...credentialValues,
			[FEISHU_SETUP_FLOW_KEY]: "edit"
		} };
		return { credentialValues: {
			...credentialValues,
			[FEISHU_SETUP_FLOW_KEY]: "new"
		} };
	},
	credentials: [],
	finalize: async ({ cfg, prompter, options, credentialValues }) => {
		if ((credentialValues[FEISHU_SETUP_FLOW_KEY] ?? "new") === "edit") {
			const result = await runEditFlow({
				cfg,
				prompter,
				options
			});
			if (result === null) return { cfg };
			return result;
		}
		return runNewAppFlow({
			cfg,
			prompter,
			options
		});
	},
	dmPolicy: feishuDmPolicy,
	disable: (cfg) => patchTopLevelChannelConfigSection({
		cfg,
		channel,
		patch: { enabled: false }
	})
};
//#endregion
//#region extensions/feishu/src/channel.ts
function readFeishuMediaParam(params) {
	const media = params.media;
	if (typeof media !== "string") return;
	return media.trim() ? media : void 0;
}
function readBooleanParam(params, keys) {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "boolean") return value;
	}
}
function hasLegacyFeishuCardCommandValue(actionValue) {
	return isRecord(actionValue) && actionValue.oc !== "ocf1" && (Boolean(typeof actionValue.command === "string" && actionValue.command.trim()) || Boolean(typeof actionValue.text === "string" && actionValue.text.trim()));
}
function containsLegacyFeishuCardCommandValue(node) {
	if (Array.isArray(node)) return node.some((item) => containsLegacyFeishuCardCommandValue(item));
	if (!isRecord(node)) return false;
	if (node.tag === "button" && hasLegacyFeishuCardCommandValue(node.value)) return true;
	return Object.values(node).some((value) => containsLegacyFeishuCardCommandValue(value));
}
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
const loadFeishuChannelRuntime = createLazyRuntimeNamedExport(() => import("./channel.runtime-DGrfWZZ3.js"), "feishuChannelRuntime");
function toFeishuMessageSendResult(result, kind) {
	const receipt = result.receipt ?? createFeishuSendReceipt({
		messageId: result.messageId,
		chatId: result.chatId ?? "",
		kind
	});
	return {
		messageId: result.messageId || receipt.primaryPlatformMessageId,
		receipt
	};
}
const feishuMessageAdapter = defineChannelMessageAdapter({
	id: "feishu",
	durableFinal: { capabilities: {
		text: true,
		media: true
	} },
	send: {
		text: async (ctx) => {
			const sendText = (await loadFeishuChannelRuntime()).feishuOutbound.sendText;
			if (!sendText) throw new Error("Feishu text sending is not available.");
			return toFeishuMessageSendResult(await sendText(ctx), "text");
		},
		media: async (ctx) => {
			const sendMedia = (await loadFeishuChannelRuntime()).feishuOutbound.sendMedia;
			if (!sendMedia) throw new Error("Feishu media sending is not available.");
			return toFeishuMessageSendResult(await sendMedia(ctx), "media");
		}
	}
});
function buildFeishuPresentationCard(params) {
	const fallbackPresentation = {
		...params.presentation.tone ? { tone: params.presentation.tone } : {},
		blocks: params.presentation.blocks
	};
	return {
		schema: "2.0",
		config: { width_mode: "fill" },
		...params.presentation.title ? { header: {
			title: {
				tag: "plain_text",
				content: params.presentation.title
			},
			template: "blue"
		} } : {},
		body: { elements: [{
			tag: "markdown",
			content: renderMessagePresentationFallbackText({
				text: params.fallbackText,
				presentation: fallbackPresentation
			})
		}] }
	};
}
async function createFeishuActionClient(account) {
	const { createFeishuClient } = await import("./client-CEkE96p-.js");
	return createFeishuClient(account);
}
const collectFeishuSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector({
	providerConfigPresent: (cfg) => cfg.channels?.feishu !== void 0,
	resolveGroupPolicy: ({ cfg, accountId }) => resolveFeishuAccount({
		cfg,
		accountId
	}).config?.groupPolicy,
	collect: ({ cfg, accountId, groupPolicy }) => {
		if (groupPolicy !== "open") return [];
		return [`- Feishu[${resolveFeishuAccount({
			cfg,
			accountId
		}).accountId}] groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.feishu.groupPolicy="allowlist" + channels.feishu.groupAllowFrom to restrict senders.`];
	}
});
function describeFeishuMessageTool({ cfg, accountId }) {
	const enabledAccounts = accountId ? [resolveFeishuAccount({
		cfg,
		accountId
	})].filter((account) => account.enabled && account.configured) : listEnabledFeishuAccounts(cfg);
	const enabled = enabledAccounts.length > 0 || !accountId && cfg.channels?.feishu?.enabled !== false && Boolean(inspectFeishuCredentials(cfg.channels?.feishu));
	if (enabledAccounts.length === 0) return {
		actions: [],
		capabilities: enabled ? ["presentation"] : []
	};
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
	if (accountId ? enabledAccounts.some((account) => isFeishuReactionsActionEnabled({
		cfg,
		account
	})) : areAnyFeishuReactionActionsEnabled(cfg)) {
		actions.add("react");
		actions.add("reactions");
	}
	return {
		actions: Array.from(actions),
		capabilities: enabled ? ["presentation"] : []
	};
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
const feishuConfigAdapter = createHybridChannelConfigAdapter({
	sectionKey: "feishu",
	listAccountIds: listFeishuAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveFeishuAccount),
	defaultAccountId: resolveDefaultFeishuAccountId,
	clearBaseFields: [],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom })
});
function isFeishuReactionsActionEnabled(params) {
	if (!params.account.enabled || !params.account.configured) return false;
	return createActionGate(params.account.config.actions ?? (params.cfg.channels?.feishu)?.actions)("reactions");
}
function areAnyFeishuReactionActionsEnabled(cfg) {
	for (const account of listEnabledFeishuAccounts(cfg)) if (isFeishuReactionsActionEnabled({
		cfg,
		account
	})) return true;
	return false;
}
function isFeishuGroupTopicSessionKey(sessionKey) {
	if (typeof sessionKey !== "string" || !sessionKey) return false;
	const parsed = parseFeishuConversationId({ conversationId: sessionKey });
	return parsed?.scope === "group_topic" || parsed?.scope === "group_topic_sender";
}
function resolveFeishuTopicAutoThreadAnchor(ctx) {
	if (ctx.action !== "send") return;
	if (!isFeishuGroupTopicSessionKey(ctx.sessionKey)) return;
	const inbound = ctx.toolContext?.currentMessageId;
	return typeof inbound === "string" && inbound.length > 0 ? inbound : void 0;
}
function buildFeishuSendReplyAnchor(ctx) {
	if (ctx.action === "thread-reply") return {
		replyToMessageId: resolveFeishuMessageId(ctx.params),
		replyInThread: true
	};
	const autoThreadId = resolveFeishuTopicAutoThreadAnchor(ctx);
	return {
		replyToMessageId: autoThreadId,
		replyInThread: autoThreadId !== void 0
	};
}
function isSupportedFeishuDirectConversationId(conversationId) {
	const trimmed = conversationId.trim();
	if (!trimmed || trimmed.includes(":")) return false;
	if (trimmed.startsWith("oc_") || trimmed.startsWith("on_")) return false;
	return true;
}
function normalizeFeishuAcpConversationId(conversationId) {
	const parsed = parseFeishuConversationId({ conversationId });
	if (!parsed || parsed.scope !== "group_topic" && parsed.scope !== "group_topic_sender" && !isSupportedFeishuDirectConversationId(parsed.canonicalConversationId)) return null;
	return {
		conversationId: parsed.canonicalConversationId,
		parentConversationId: parsed.scope === "group_topic" || parsed.scope === "group_topic_sender" ? parsed.chatId : void 0
	};
}
function matchFeishuAcpConversation(params) {
	const binding = normalizeFeishuAcpConversationId(params.bindingConversationId);
	if (!binding) return null;
	const incoming = parseFeishuConversationId({
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (!incoming || incoming.scope !== "group_topic" && incoming.scope !== "group_topic_sender" && !isSupportedFeishuDirectConversationId(incoming.canonicalConversationId)) return null;
	const matchesCanonicalConversation = binding.conversationId === incoming.canonicalConversationId;
	const matchesParentTopicForSenderScopedConversation = incoming.scope === "group_topic_sender" && binding.parentConversationId === incoming.chatId && binding.conversationId === `${incoming.chatId}:topic:${incoming.topicId}`;
	if (!matchesCanonicalConversation && !matchesParentTopicForSenderScopedConversation) return null;
	return {
		conversationId: matchesParentTopicForSenderScopedConversation ? binding.conversationId : incoming.canonicalConversationId,
		parentConversationId: incoming.scope === "group_topic" || incoming.scope === "group_topic_sender" ? incoming.chatId : void 0,
		matchPriority: matchesCanonicalConversation ? 2 : 1
	};
}
function resolveFeishuSenderScopedCommandConversation(params) {
	const parentConversationId = params.parentConversationId?.trim();
	const threadId = params.threadId?.trim();
	const senderId = params.senderId?.trim();
	if (!parentConversationId || !threadId || !senderId) return;
	const expectedScopePrefix = `feishu:group:${normalizeLowercaseStringOrEmpty(parentConversationId)}:topic:${normalizeLowercaseStringOrEmpty(threadId)}:sender:`;
	const isSenderScopedSession = [params.sessionKey, params.parentSessionKey].some((candidate) => {
		const normalized = normalizeLowercaseStringOrEmpty(candidate ?? "");
		if (!normalized) return false;
		return normalized.replace(/^agent:[^:]+:/, "").startsWith(expectedScopePrefix);
	});
	const senderScopedConversationId = buildFeishuConversationId({
		chatId: parentConversationId,
		scope: "group_topic_sender",
		topicId: threadId,
		senderOpenId: senderId
	});
	if (isSenderScopedSession) return senderScopedConversationId;
	if (!params.sessionKey?.trim()) return;
	return getSessionBindingService().listBySession(params.sessionKey).find((binding) => {
		if (binding.conversation.channel !== "feishu" || binding.conversation.accountId !== params.accountId) return false;
		return binding.conversation.conversationId === senderScopedConversationId;
	})?.conversation.conversationId;
}
function resolveFeishuCommandConversation(params) {
	if (params.threadId) {
		const parentConversationId = parseFeishuTargetId(params.originatingTo) ?? parseFeishuTargetId(params.commandTo) ?? parseFeishuTargetId(params.fallbackTo);
		if (!parentConversationId) return null;
		return {
			conversationId: resolveFeishuSenderScopedCommandConversation({
				accountId: params.accountId,
				parentConversationId,
				threadId: params.threadId,
				senderId: params.senderId,
				sessionKey: params.sessionKey,
				parentSessionKey: params.parentSessionKey
			}) ?? buildFeishuConversationId({
				chatId: parentConversationId,
				scope: "group_topic",
				topicId: params.threadId
			}),
			parentConversationId
		};
	}
	const conversationId = parseFeishuDirectConversationId(params.originatingTo) ?? parseFeishuDirectConversationId(params.commandTo) ?? parseFeishuDirectConversationId(params.fallbackTo);
	return conversationId ? { conversationId } : null;
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
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
}
function readOptionalNumber(params, keys) {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
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
	if (!raw) return;
	if (/^(user|dm|open_id):/i.test(raw)) return;
	if (/^(chat|group|channel):/i.test(raw)) return normalizeFeishuTarget(raw) ?? void 0;
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
	if (raw === "open_id" || raw === "user_id" || raw === "union_id") return raw;
	if (readFirstString(params, ["userId", "user_id"]) && !readFirstString(params, [
		"openId",
		"open_id",
		"unionId",
		"union_id"
	])) return "user_id";
	if (readFirstString(params, ["unionId", "union_id"]) && !readFirstString(params, ["openId", "open_id"])) return "union_id";
	return "open_id";
}
const feishuPlugin = createChatChannelPlugin({
	base: {
		id: "feishu",
		meta: { ...meta },
		capabilities: {
			chatTypes: ["direct", "channel"],
			polls: false,
			threads: true,
			media: true,
			tts: { voice: {
				synthesisTarget: "voice-note",
				transcodesAudio: true
			} },
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
		conversationBindings: {
			defaultTopLevelPlacement: "current",
			buildModelOverrideParentCandidates: ({ parentConversationId }) => buildFeishuModelOverrideParentCandidates(parentConversationId)
		},
		mentions: { stripPatterns: () => ["<at user_id=\"[^\"]*\">[^<]*</at>"] },
		reload: { configPrefixes: ["channels.feishu"] },
		configSchema: buildChannelConfigSchema(FeishuConfigSchema),
		config: {
			...feishuConfigAdapter,
			setAccountEnabled: ({ cfg, accountId, enabled }) => {
				if (accountId === "default") return {
					...cfg,
					channels: {
						...cfg.channels,
						feishu: {
							...cfg.channels?.feishu,
							enabled
						}
					}
				};
				return setFeishuNamedAccountEnabled(cfg, accountId, enabled);
			},
			deleteAccount: ({ cfg, accountId }) => {
				if (accountId === "default") {
					const next = { ...cfg };
					const nextChannels = { ...cfg.channels };
					delete nextChannels.feishu;
					if (Object.keys(nextChannels).length > 0) next.channels = nextChannels;
					else delete next.channels;
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
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: account.configured,
				extra: {
					appId: account.appId,
					domain: account.domain
				}
			})
		},
		approvalCapability: feishuApprovalAuth,
		secrets: {
			secretTargetRegistryEntries,
			collectRuntimeConfigAssignments
		},
		actions: {
			messageActionTargetAliases,
			describeMessageTool: describeFeishuMessageTool,
			handleAction: async (ctx) => {
				const account = resolveFeishuAccount({
					cfg: ctx.cfg,
					accountId: ctx.accountId ?? void 0
				});
				if ((ctx.action === "react" || ctx.action === "reactions") && !isFeishuReactionsActionEnabled({
					cfg: ctx.cfg,
					account
				})) throw new Error("Feishu reactions are disabled via actions.reactions.");
				if (ctx.action === "send" || ctx.action === "thread-reply") {
					const to = resolveFeishuActionTarget(ctx);
					if (!to) throw new Error(`Feishu ${ctx.action} requires a target (to).`);
					const { replyToMessageId, replyInThread } = buildFeishuSendReplyAnchor(ctx);
					if (ctx.action === "thread-reply" && !replyToMessageId) throw new Error("Feishu thread-reply requires messageId.");
					const presentation = normalizeMessagePresentation(ctx.params.presentation);
					const text = readFirstString(ctx.params, ["text", "message"]);
					const mediaUrl = readFeishuMediaParam(ctx.params);
					const audioAsVoice = readBooleanParam(ctx.params, ["asVoice", "audioAsVoice"]);
					const card = presentation ? buildFeishuPresentationCard({
						presentation,
						fallbackText: text
					}) : void 0;
					if (card && mediaUrl) throw new Error(`Feishu ${ctx.action} does not support card with media.`);
					if (!card && !text && !mediaUrl) throw new Error(`Feishu ${ctx.action} requires text/message, media, or card.`);
					const runtime = await loadFeishuChannelRuntime();
					const maybeSendMedia = runtime.feishuOutbound.sendMedia;
					if (mediaUrl && !maybeSendMedia) throw new Error("Feishu media sending is not available.");
					const sendMedia = maybeSendMedia;
					let result;
					if (card) {
						if (containsLegacyFeishuCardCommandValue(card)) throw new Error("Feishu card buttons that trigger text or commands must use structured interaction envelopes.");
						result = await runtime.sendCardFeishu({
							cfg: ctx.cfg,
							to,
							card,
							accountId: ctx.accountId ?? void 0,
							replyToMessageId,
							replyInThread
						});
					} else if (mediaUrl) result = await sendMedia({
						cfg: ctx.cfg,
						to,
						text: text ?? "",
						mediaUrl,
						accountId: ctx.accountId ?? void 0,
						mediaLocalRoots: ctx.mediaLocalRoots,
						...replyInThread ? { threadId: replyToMessageId } : { replyToId: replyToMessageId },
						...audioAsVoice === true ? { audioAsVoice: true } : {}
					});
					else result = await runtime.sendMessageFeishu({
						cfg: ctx.cfg,
						to,
						text,
						accountId: ctx.accountId ?? void 0,
						replyToMessageId,
						replyInThread
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
					if (!messageId) throw new Error("Feishu read requires messageId.");
					const { getMessageFeishu } = await loadFeishuChannelRuntime();
					const message = await getMessageFeishu({
						cfg: ctx.cfg,
						messageId,
						accountId: ctx.accountId ?? void 0
					});
					if (!message) return {
						isError: true,
						content: [{
							type: "text",
							text: JSON.stringify({ error: `Feishu read failed or message not found: ${messageId}` })
						}],
						details: { error: `Feishu read failed or message not found: ${messageId}` }
					};
					return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "read",
						message
					});
				}
				if (ctx.action === "edit") {
					const messageId = resolveFeishuMessageId(ctx.params);
					if (!messageId) throw new Error("Feishu edit requires messageId.");
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
					if (!messageId) throw new Error("Feishu pin requires messageId.");
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
					if (!messageId) throw new Error("Feishu unpin requires messageId.");
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
					if (!chatId) throw new Error("Feishu list-pins requires chatId or channelId.");
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
					if (!chatId) throw new Error("Feishu channel-info requires chatId or channelId.");
					const runtime = await loadFeishuChannelRuntime();
					const client = await createFeishuActionClient(account);
					const channel = await runtime.getChatInfo(client, chatId);
					if (!(ctx.params.includeMembers === true || ctx.params.members === true)) return jsonActionResult({
						ok: true,
						provider: "feishu",
						action: "channel-info",
						channel
					});
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
					const client = await createFeishuActionClient(account);
					const memberId = resolveFeishuMemberId(ctx.params);
					if (memberId) return jsonActionResult({
						ok: true,
						channel: "feishu",
						action: "member-info",
						member: await runtime.getFeishuMemberInfo(client, memberId, resolveFeishuMemberIdType(ctx.params))
					});
					const chatId = resolveFeishuChatId(ctx);
					if (!chatId) throw new Error("Feishu member-info requires memberId or chatId/channelId.");
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
					if (scope === "groups" || scope === "group" || scope === "channels" || scope === "channel") return jsonActionResult({
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
					});
					if (scope === "peers" || scope === "peer" || scope === "members" || scope === "member" || scope === "users" || scope === "user") return jsonActionResult({
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
					});
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
					if (!messageId) throw new Error("Feishu reaction requires messageId.");
					const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
					const remove = ctx.params.remove === true;
					const clearAll = ctx.params.clearAll === true;
					if (remove) {
						if (!emoji) throw new Error("Emoji is required to remove a Feishu reaction.");
						const { listReactionsFeishu, removeReactionFeishu } = await loadFeishuChannelRuntime();
						const ownReaction = (await listReactionsFeishu({
							cfg: ctx.cfg,
							messageId,
							emojiType: emoji,
							accountId: ctx.accountId ?? void 0
						})).find((entry) => entry.operatorType === "app");
						if (!ownReaction) return jsonActionResult({
							ok: true,
							removed: null
						});
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
						if (!clearAll) throw new Error("Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.");
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
					if (!messageId) throw new Error("Feishu reactions lookup requires messageId.");
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
				throw new Error(`Unsupported Feishu action: "${ctx.action}"`);
			}
		},
		bindings: {
			compileConfiguredBinding: ({ conversationId }) => normalizeFeishuAcpConversationId(conversationId),
			matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => matchFeishuAcpConversation({
				bindingConversationId: compiledBinding.conversationId,
				conversationId,
				parentConversationId
			}),
			resolveCommandConversation: ({ accountId, threadId, senderId, sessionKey, parentSessionKey, originatingTo, commandTo, fallbackTo }) => resolveFeishuCommandConversation({
				accountId,
				threadId,
				senderId,
				sessionKey,
				parentSessionKey,
				originatingTo,
				commandTo,
				fallbackTo
			})
		},
		auth: { login: async ({ cfg }) => {
			const { createClackPrompter } = await import("./plugin-sdk/setup-runtime.js");
			const { replaceConfigFile } = await import("./plugin-sdk/config-mutation.js");
			const nextCfg = await runFeishuLogin({
				cfg,
				prompter: createClackPrompter()
			});
			if (nextCfg !== cfg) await replaceConfigFile({
				nextConfig: nextCfg,
				afterWrite: { mode: "auto" }
			});
		} },
		setup: feishuSetupAdapter,
		setupWizard: feishuSetupWizard,
		messaging: {
			targetPrefixes: ["feishu", "lark"],
			normalizeTarget: (raw) => normalizeFeishuTarget(raw) ?? void 0,
			resolveDeliveryTarget: ({ conversationId, parentConversationId }) => {
				const directId = parseFeishuDirectConversationId(conversationId);
				if (directId) return { to: `user:${directId}` };
				const parsed = parseFeishuConversationId({
					conversationId,
					parentConversationId
				});
				if (parsed?.topicId) return {
					to: `chat:${parentConversationId?.trim() || parsed.chatId}`,
					threadId: parsed.topicId
				};
				return { to: `chat:${parsed?.chatId ?? conversationId.trim()}` };
			},
			resolveSessionConversation: ({ kind, rawId }) => resolveFeishuSessionConversation({
				kind,
				rawId
			}),
			resolveOutboundSessionRoute: (params) => resolveFeishuOutboundSessionRoute(params),
			targetResolver: {
				looksLikeId: looksLikeFeishuId,
				hint: "<chatId|user:openId|chat:chatId>"
			}
		},
		directory: createChannelDirectoryAdapter({
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
			...createRuntimeDirectoryLiveAdapter({
				getRuntime: loadFeishuChannelRuntime,
				listPeersLive: (runtime) => async ({ cfg, query, limit, accountId }) => await runtime.listFeishuDirectoryPeersLive({
					cfg,
					query: query ?? void 0,
					limit: limit ?? void 0,
					accountId: accountId ?? void 0
				}),
				listGroupsLive: (runtime) => async ({ cfg, query, limit, accountId }) => await runtime.listFeishuDirectoryGroupsLive({
					cfg,
					query: query ?? void 0,
					limit: limit ?? void 0,
					accountId: accountId ?? void 0
				})
			})
		}),
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
			buildChannelSummary: ({ snapshot }) => buildProbeChannelStatusSummary(snapshot, { port: snapshot.port ?? null }),
			probeAccount: async ({ account }) => await (await loadFeishuChannelRuntime()).probeFeishu(account),
			resolveAccountSnapshot: ({ account, runtime }) => ({
				accountId: account.accountId,
				enabled: account.enabled,
				configured: account.configured,
				name: account.name,
				extra: {
					appId: account.appId,
					domain: account.domain,
					port: runtime?.port ?? null
				}
			})
		}),
		gateway: { startAccount: async (ctx) => {
			const { monitorFeishuProvider } = await import("./monitor-Bog7UNtj.js");
			const account = resolveFeishuRuntimeAccount({
				cfg: ctx.cfg,
				accountId: ctx.accountId
			}, { requireEventSecrets: true });
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
		} },
		message: feishuMessageAdapter
	},
	security: {
		collectWarnings: projectConfigAccountIdWarningCollector(collectFeishuSecurityWarnings),
		collectAuditFindings: ({ cfg }) => collectFeishuSecurityAuditFindings({ cfg })
	},
	pairing: { text: {
		idLabel: "feishuUserId",
		message: PAIRING_APPROVED_MESSAGE,
		normalizeAllowEntry: createPairingPrefixStripper(/^(feishu|user|open_id):/i),
		notify: async ({ cfg, id, message, accountId }) => {
			const { sendMessageFeishu } = await loadFeishuChannelRuntime();
			await sendMessageFeishu({
				cfg,
				to: id,
				text: message,
				accountId
			});
		}
	} },
	outbound: {
		deliveryMode: "direct",
		chunker: chunkTextForOutbound,
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		presentationCapabilities: {
			supported: true,
			buttons: true,
			selects: false,
			context: true,
			divider: true,
			limits: {
				actions: {
					maxActions: 20,
					maxActionsPerRow: 5,
					maxLabelLength: 40,
					maxValueBytes: 1024
				},
				text: {
					maxLength: 4e3,
					encoding: "characters",
					markdownDialect: "markdown"
				}
			}
		},
		renderPresentation: async (ctx) => {
			const renderPresentation = (await loadFeishuChannelRuntime()).feishuOutbound.renderPresentation;
			return renderPresentation ? await renderPresentation(ctx) : null;
		},
		sendPayload: async (ctx) => {
			const sendPayload = (await loadFeishuChannelRuntime()).feishuOutbound.sendPayload;
			if (!sendPayload) throw new Error("Feishu payload sending is not available.");
			return await sendPayload(ctx);
		},
		...createRuntimeOutboundDelegates({
			getRuntime: loadFeishuChannelRuntime,
			sendText: { resolve: (runtime) => runtime.feishuOutbound.sendText },
			sendMedia: { resolve: (runtime) => runtime.feishuOutbound.sendMedia }
		})
	}
});
//#endregion
export { setFeishuNamedAccountEnabled$1 as a, feishuSetupAdapter as i, feishuSetupWizard as n, runFeishuLogin as r, feishuPlugin as t };
