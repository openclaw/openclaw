import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import { d as resolveThreadSessionKeys, h as DEFAULT_ACCOUNT_ID } from "../../session-key-BfFG0xOA.js";
import { bn as buildChannelConfigSchema, dn as PAIRING_APPROVED_MESSAGE, fn as buildAccountScopedDmSecurityPolicy, m as getChatChannelMeta, t as buildAgentSessionKey } from "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import { l as isRecord } from "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../core-qWFcsWSH.js";
import "../../paths-OqPpu-UR.js";
import { A as collectOpenGroupPolicyConfiguredRouteWarnings, Fu as listSlackMessageActions, Gu as isSlackInteractiveRepliesEnabled, Iu as inspectSlackAccount, Ju as resolveSlackAccount, Ku as listSlackAccountIds, Mu as parseSlackBlocksInput, N as collectOpenProviderGroupPolicyWarnings, Nu as buildSlackThreadingToolContext, Pu as extractSlackToolSend, Sl as slackSetupAdapter, Yu as resolveSlackReplyToMode, _f as SlackConfigSchema, ap as listSlackDirectoryPeersFromConfig, b as createPluginRuntimeStore, bt as formatAllowFromLowercase, cl as resolveSlackGroupToolPolicy, dp as normalizeSlackMessagingTarget, fp as parseSlackTarget, gl as buildSlackInteractiveBlocks, ip as listSlackDirectoryGroupsFromConfig, oi as resolveOutboundSendDep, qu as resolveDefaultSlackAccountId, rd as resolveConfiguredFromRequiredCredentialStatuses, sl as resolveSlackGroupRequireMention, td as projectCredentialSnapshotFields, up as looksLikeSlackTargetId, vp as createScopedAccountConfigAccessors, xl as createSlackSetupWizardProxy, yl as resolveSlackUserAllowlist, yp as createScopedChannelConfigBase, yu as createSlackWebClient, zu as buildComputedAccountStatusSnapshot } from "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-BpDGEQsl.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { g as buildAccountScopedAllowlistConfigEditor } from "../../compat-DDXNEdAm.js";
import "../../inbound-envelope-DsNRW6ln.js";
import "../../run-command-Psw08BkS.js";
import "../../device-pairing-DYWF-CWB.js";
import "../../line-iO245OTq.js";
import "../../upsert-with-lock-CLs2bE4R.js";
import "../../self-hosted-provider-setup-C4OZCxyb.js";
import "../../ollama-setup-BM-G12b6.js";
import { n as buildPassiveProbedChannelStatusSummary } from "../../channel-status-summary-C_aBM2lc.js";
import { r as normalizeAllowListLower } from "../../allow-list-Cl2MWpf9.js";
//#region extensions/slack/src/message-action-dispatch.ts
function readTrimmedString(value) {
	if (typeof value !== "string") return;
	return value.trim() || void 0;
}
function normalizeButtonStyle(value) {
	const style = readTrimmedString(value)?.toLowerCase();
	return style === "primary" || style === "secondary" || style === "success" || style === "danger" ? style : void 0;
}
function normalizeInteractiveButton(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const record = raw;
	const label = readTrimmedString(record.label) ?? readTrimmedString(record.text);
	const value = readTrimmedString(record.value) ?? readTrimmedString(record.callbackData) ?? readTrimmedString(record.callback_data);
	if (!label || !value) return;
	return {
		label,
		value,
		style: normalizeButtonStyle(record.style)
	};
}
function normalizeInteractiveOption(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const record = raw;
	const label = readTrimmedString(record.label) ?? readTrimmedString(record.text);
	const value = readTrimmedString(record.value);
	return label && value ? {
		label,
		value
	} : void 0;
}
function normalizeInteractiveReply(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const record = raw;
	const blocks = Array.isArray(record.blocks) ? record.blocks.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
		const block = entry;
		const type = readTrimmedString(block.type)?.toLowerCase();
		if (type === "text") {
			const text = readTrimmedString(block.text);
			return text ? {
				type: "text",
				text
			} : void 0;
		}
		if (type === "buttons") {
			const buttons = Array.isArray(block.buttons) ? block.buttons.map((button) => normalizeInteractiveButton(button)).filter((button) => Boolean(button)) : [];
			return buttons.length > 0 ? {
				type: "buttons",
				buttons
			} : void 0;
		}
		if (type === "select") {
			const options = Array.isArray(block.options) ? block.options.map((option) => normalizeInteractiveOption(option)).filter((option) => Boolean(option)) : [];
			return options.length > 0 ? {
				type: "select",
				placeholder: readTrimmedString(block.placeholder),
				options
			} : void 0;
		}
	}).filter((entry) => Boolean(entry)) : [];
	return blocks.length > 0 ? { blocks } : void 0;
}
function readStringParam(params, key, options = {}) {
	const { required = false, trim = true, label = key, allowEmpty = false } = options;
	const raw = params[key];
	if (typeof raw !== "string") {
		if (required) throw new Error(`${label} required`);
		return;
	}
	const value = trim ? raw.trim() : raw;
	if (!value && !allowEmpty) {
		if (required) throw new Error(`${label} required`);
		return;
	}
	return value;
}
function readNumberParam(params, key, options = {}) {
	const { required = false, label = key, integer = false, strict = false } = options;
	const raw = params[key];
	let value;
	if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
	else if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed) {
			const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
			if (Number.isFinite(parsed)) value = parsed;
		}
	}
	if (value === void 0) {
		if (required) throw new Error(`${label} required`);
		return;
	}
	return integer ? Math.trunc(value) : value;
}
function readSlackBlocksParam(actionParams) {
	return parseSlackBlocksInput(actionParams.blocks);
}
async function handleSlackMessageAction(params) {
	const { providerId, ctx, invoke, normalizeChannelId, includeReadThreadId = false } = params;
	const { action, cfg, params: actionParams } = ctx;
	const accountId = ctx.accountId ?? void 0;
	const resolveChannelId = () => {
		const channelId = readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to", { required: true });
		if (!channelId) throw new Error("channelId required");
		return normalizeChannelId ? normalizeChannelId(channelId) : channelId;
	};
	if (action === "send") {
		const to = readStringParam(actionParams, "to", { required: true });
		const content = readStringParam(actionParams, "message", { allowEmpty: true });
		const mediaUrl = readStringParam(actionParams, "media", { trim: false });
		const interactive = normalizeInteractiveReply(actionParams.interactive);
		const interactiveBlocks = interactive ? buildSlackInteractiveBlocks(interactive) : void 0;
		const blocks = readSlackBlocksParam(actionParams) ?? interactiveBlocks;
		if (!content && !mediaUrl && !blocks) throw new Error("Slack send requires message, blocks, or media.");
		if (mediaUrl && blocks) throw new Error("Slack send does not support blocks with media.");
		const threadId = readStringParam(actionParams, "threadId");
		const replyTo = readStringParam(actionParams, "replyTo");
		return await invoke({
			action: "sendMessage",
			to,
			content: content ?? "",
			mediaUrl: mediaUrl ?? void 0,
			accountId,
			threadTs: threadId ?? replyTo ?? void 0,
			...blocks ? { blocks } : {}
		}, cfg, ctx.toolContext);
	}
	if (action === "react") {
		const messageId = readStringParam(actionParams, "messageId", { required: true });
		const emoji = readStringParam(actionParams, "emoji", { allowEmpty: true });
		const remove = typeof actionParams.remove === "boolean" ? actionParams.remove : void 0;
		return await invoke({
			action: "react",
			channelId: resolveChannelId(),
			messageId,
			emoji,
			remove,
			accountId
		}, cfg);
	}
	if (action === "reactions") {
		const messageId = readStringParam(actionParams, "messageId", { required: true });
		const limit = readNumberParam(actionParams, "limit", { integer: true });
		return await invoke({
			action: "reactions",
			channelId: resolveChannelId(),
			messageId,
			limit,
			accountId
		}, cfg);
	}
	if (action === "read") {
		const limit = readNumberParam(actionParams, "limit", { integer: true });
		const readAction = {
			action: "readMessages",
			channelId: resolveChannelId(),
			limit,
			before: readStringParam(actionParams, "before"),
			after: readStringParam(actionParams, "after"),
			accountId
		};
		if (includeReadThreadId) readAction.threadId = readStringParam(actionParams, "threadId");
		return await invoke(readAction, cfg);
	}
	if (action === "edit") {
		const messageId = readStringParam(actionParams, "messageId", { required: true });
		const content = readStringParam(actionParams, "message", { allowEmpty: true });
		const blocks = readSlackBlocksParam(actionParams);
		if (!content && !blocks) throw new Error("Slack edit requires message or blocks.");
		return await invoke({
			action: "editMessage",
			channelId: resolveChannelId(),
			messageId,
			content: content ?? "",
			blocks,
			accountId
		}, cfg);
	}
	if (action === "delete") {
		const messageId = readStringParam(actionParams, "messageId", { required: true });
		return await invoke({
			action: "deleteMessage",
			channelId: resolveChannelId(),
			messageId,
			accountId
		}, cfg);
	}
	if (action === "pin" || action === "unpin" || action === "list-pins") {
		const messageId = action === "list-pins" ? void 0 : readStringParam(actionParams, "messageId", { required: true });
		return await invoke({
			action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
			channelId: resolveChannelId(),
			messageId,
			accountId
		}, cfg);
	}
	if (action === "member-info") return await invoke({
		action: "memberInfo",
		userId: readStringParam(actionParams, "userId", { required: true }),
		accountId
	}, cfg);
	if (action === "emoji-list") return await invoke({
		action: "emojiList",
		limit: readNumberParam(actionParams, "limit", { integer: true }),
		accountId
	}, cfg);
	if (action === "download-file") {
		const fileId = readStringParam(actionParams, "fileId", { required: true });
		const channelId = readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to");
		const threadId = readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo");
		return await invoke({
			action: "downloadFile",
			fileId,
			channelId: channelId ?? void 0,
			threadId: threadId ?? void 0,
			accountId
		}, cfg);
	}
	throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
//#endregion
//#region extensions/slack/src/runtime.ts
const { setRuntime: setSlackRuntime, getRuntime: getSlackRuntime } = createPluginRuntimeStore("Slack runtime not initialized");
//#endregion
//#region extensions/slack/src/scopes.ts
function collectScopes(value, into) {
	if (!value) return;
	if (Array.isArray(value)) {
		for (const entry of value) if (typeof entry === "string" && entry.trim()) into.push(entry.trim());
		return;
	}
	if (typeof value === "string") {
		const raw = value.trim();
		if (!raw) return;
		const parts = raw.split(/[,\s]+/).map((part) => part.trim());
		for (const part of parts) if (part) into.push(part);
		return;
	}
	if (!isRecord(value)) return;
	for (const entry of Object.values(value)) if (Array.isArray(entry) || typeof entry === "string") collectScopes(entry, into);
}
function normalizeScopes(scopes) {
	return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean))).toSorted();
}
function extractScopes(payload) {
	if (!isRecord(payload)) return [];
	const scopes = [];
	collectScopes(payload.scopes, scopes);
	collectScopes(payload.scope, scopes);
	if (isRecord(payload.info)) {
		collectScopes(payload.info.scopes, scopes);
		collectScopes(payload.info.scope, scopes);
		collectScopes(payload.info.user_scopes, scopes);
		collectScopes(payload.info.bot_scopes, scopes);
	}
	return normalizeScopes(scopes);
}
function readError(payload) {
	if (!isRecord(payload)) return;
	const error = payload.error;
	return typeof error === "string" && error.trim() ? error.trim() : void 0;
}
async function callSlack(client, method) {
	try {
		const result = await client.apiCall(method);
		return isRecord(result) ? result : null;
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
async function fetchSlackScopes(token, timeoutMs) {
	const client = createSlackWebClient(token, { timeout: timeoutMs });
	const attempts = ["auth.scopes", "apps.permissions.info"];
	const errors = [];
	for (const method of attempts) {
		const result = await callSlack(client, method);
		const scopes = extractScopes(result);
		if (scopes.length > 0) return {
			ok: true,
			scopes,
			source: method
		};
		const error = readError(result);
		if (error) errors.push(`${method}: ${error}`);
	}
	return {
		ok: false,
		error: errors.length > 0 ? errors.join(" | ") : "no scopes returned"
	};
}
//#endregion
//#region extensions/slack/src/channel.ts
const meta = getChatChannelMeta("slack");
const SLACK_CHANNEL_TYPE_CACHE = /* @__PURE__ */ new Map();
async function loadSlackChannelRuntime() {
	return await import("../../channel.runtime-DGfq4vZk.js");
}
function getTokenForOperation(account, operation) {
	const userToken = account.config.userToken?.trim() || void 0;
	const botToken = account.botToken?.trim();
	const allowUserWrites = account.config.userTokenReadOnly === false;
	if (operation === "read") return userToken ?? botToken;
	if (!allowUserWrites) return botToken;
	return botToken ?? userToken;
}
function isSlackAccountConfigured(account) {
	const mode = account.config.mode ?? "socket";
	if (!Boolean(account.botToken?.trim())) return false;
	if (mode === "http") return Boolean(account.config.signingSecret?.trim());
	return Boolean(account.appToken?.trim());
}
function resolveSlackSendContext(params) {
	const send = resolveOutboundSendDep(params.deps, "slack") ?? getSlackRuntime().channel.slack.sendMessageSlack;
	const account = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const token = getTokenForOperation(account, "write");
	const botToken = account.botToken?.trim();
	const tokenOverride = token && token !== botToken ? token : void 0;
	return {
		send,
		threadTsValue: params.replyToId ?? params.threadId,
		tokenOverride
	};
}
function resolveSlackAutoThreadId(params) {
	const context = params.toolContext;
	if (!context?.currentThreadTs || !context.currentChannelId) return;
	if (context.replyToMode !== "all" && context.replyToMode !== "first") return;
	const parsedTarget = parseSlackTarget(params.to, { defaultKind: "channel" });
	if (!parsedTarget || parsedTarget.kind !== "channel") return;
	if (parsedTarget.id.toLowerCase() !== context.currentChannelId.toLowerCase()) return;
	if (context.replyToMode === "first" && context.hasRepliedRef?.value) return;
	return context.currentThreadTs;
}
function parseSlackExplicitTarget(raw) {
	const target = parseSlackTarget(raw, { defaultKind: "channel" });
	if (!target) return null;
	return {
		to: target.id,
		chatType: target.kind === "user" ? "direct" : "channel"
	};
}
function normalizeOutboundThreadId(value) {
	if (value == null) return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return;
		return String(Math.trunc(value));
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function buildSlackBaseSessionKey(params) {
	return buildAgentSessionKey({
		agentId: params.agentId,
		channel: "slack",
		accountId: params.accountId,
		peer: params.peer,
		dmScope: params.cfg.session?.dmScope ?? "main",
		identityLinks: params.cfg.session?.identityLinks
	});
}
async function resolveSlackChannelType(params) {
	const channelId = params.channelId.trim();
	if (!channelId) return "unknown";
	const cacheKey = `${params.accountId ?? "default"}:${channelId}`;
	const cached = SLACK_CHANNEL_TYPE_CACHE.get(cacheKey);
	if (cached) return cached;
	const account = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const groupChannels = normalizeAllowListLower(account.dm?.groupChannels);
	const channelIdLower = channelId.toLowerCase();
	if (groupChannels.includes(channelIdLower) || groupChannels.includes(`slack:${channelIdLower}`) || groupChannels.includes(`channel:${channelIdLower}`) || groupChannels.includes(`group:${channelIdLower}`) || groupChannels.includes(`mpim:${channelIdLower}`)) {
		SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "group");
		return "group";
	}
	if (Object.keys(account.channels ?? {}).some((key) => {
		const normalized = key.trim().toLowerCase();
		return normalized === channelIdLower || normalized === `channel:${channelIdLower}` || normalized.replace(/^#/, "") === channelIdLower;
	})) {
		SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "channel");
		return "channel";
	}
	const token = account.botToken?.trim() || account.config.userToken?.trim() || "";
	if (!token) {
		SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "unknown");
		return "unknown";
	}
	try {
		const channel = (await createSlackWebClient(token).conversations.info({ channel: channelId })).channel;
		const type = channel?.is_im ? "dm" : channel?.is_mpim ? "group" : "channel";
		SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, type);
		return type;
	} catch {
		SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "unknown");
		return "unknown";
	}
}
async function resolveSlackOutboundSessionRoute(params) {
	const parsed = parseSlackTarget(params.target, { defaultKind: "channel" });
	if (!parsed) return null;
	const isDm = parsed.kind === "user";
	let peerKind = isDm ? "direct" : "channel";
	if (!isDm && /^G/i.test(parsed.id)) {
		const channelType = await resolveSlackChannelType({
			cfg: params.cfg,
			accountId: params.accountId,
			channelId: parsed.id
		});
		if (channelType === "group") peerKind = "group";
		if (channelType === "dm") peerKind = "direct";
	}
	const peer = {
		kind: peerKind,
		id: parsed.id
	};
	const baseSessionKey = buildSlackBaseSessionKey({
		cfg: params.cfg,
		agentId: params.agentId,
		accountId: params.accountId,
		peer
	});
	const threadId = normalizeOutboundThreadId(params.threadId ?? params.replyToId);
	return {
		sessionKey: resolveThreadSessionKeys({
			baseSessionKey,
			threadId
		}).sessionKey,
		baseSessionKey,
		peer,
		chatType: peerKind === "direct" ? "direct" : "channel",
		from: peerKind === "direct" ? `slack:${parsed.id}` : peerKind === "group" ? `slack:group:${parsed.id}` : `slack:channel:${parsed.id}`,
		to: peerKind === "direct" ? `user:${parsed.id}` : `channel:${parsed.id}`,
		threadId
	};
}
function formatSlackScopeDiagnostic(params) {
	const source = params.result.source ? ` (${params.result.source})` : "";
	const label = params.tokenType === "user" ? "User scopes" : "Bot scopes";
	if (params.result.ok && params.result.scopes?.length) return { text: `${label}${source}: ${params.result.scopes.join(", ")}` };
	return {
		text: `${label}: ${params.result.error ?? "scope lookup failed"}`,
		tone: "error"
	};
}
function readSlackAllowlistConfig(account) {
	return {
		dmAllowFrom: (account.config.allowFrom ?? account.config.dm?.allowFrom ?? []).map(String),
		groupPolicy: account.groupPolicy,
		groupOverrides: Object.entries(account.channels ?? {}).map(([key, value]) => {
			const entries = (value?.users ?? []).map(String).filter(Boolean);
			return entries.length > 0 ? {
				label: key,
				entries
			} : null;
		}).filter(Boolean)
	};
}
async function resolveSlackAllowlistNames(params) {
	const account = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const token = account.config.userToken?.trim() || account.botToken?.trim();
	if (!token) return [];
	return await resolveSlackUserAllowlist({
		token,
		entries: params.entries
	});
}
const slackConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveSlackAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.dm?.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const slackConfigBase = createScopedChannelConfigBase({
	sectionKey: "slack",
	listAccountIds: listSlackAccountIds,
	resolveAccount: (cfg, accountId) => resolveSlackAccount({
		cfg,
		accountId
	}),
	inspectAccount: (cfg, accountId) => inspectSlackAccount({
		cfg,
		accountId
	}),
	defaultAccountId: resolveDefaultSlackAccountId,
	clearBaseFields: [
		"botToken",
		"appToken",
		"name"
	]
});
const slackSetupWizard = createSlackSetupWizardProxy(async () => ({ slackSetupWizard: (await loadSlackChannelRuntime()).slackSetupWizard }));
const slackPlugin = {
	id: "slack",
	meta: {
		...meta,
		preferSessionLookupForAnnounceTarget: true
	},
	setupWizard: slackSetupWizard,
	pairing: {
		idLabel: "slackUserId",
		normalizeAllowEntry: (entry) => entry.replace(/^(slack|user):/i, ""),
		notifyApproval: async ({ id }) => {
			const account = resolveSlackAccount({
				cfg: getSlackRuntime().config.loadConfig(),
				accountId: DEFAULT_ACCOUNT_ID
			});
			const token = getTokenForOperation(account, "write");
			const botToken = account.botToken?.trim();
			const tokenOverride = token && token !== botToken ? token : void 0;
			if (tokenOverride) await getSlackRuntime().channel.slack.sendMessageSlack(`user:${id}`, PAIRING_APPROVED_MESSAGE, { token: tokenOverride });
			else await getSlackRuntime().channel.slack.sendMessageSlack(`user:${id}`, PAIRING_APPROVED_MESSAGE);
		}
	},
	capabilities: {
		chatTypes: [
			"direct",
			"channel",
			"thread"
		],
		reactions: true,
		threads: true,
		media: true,
		nativeCommands: true
	},
	agentPrompt: { messageToolHints: ({ cfg, accountId }) => isSlackInteractiveRepliesEnabled({
		cfg,
		accountId
	}) ? ["- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.", "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event."] : ["- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`)."] },
	streaming: { blockStreamingCoalesceDefaults: {
		minChars: 1500,
		idleMs: 1e3
	} },
	reload: { configPrefixes: ["channels.slack"] },
	configSchema: buildChannelConfigSchema(SlackConfigSchema),
	config: {
		...slackConfigBase,
		isConfigured: (account) => isSlackAccountConfigured(account),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: isSlackAccountConfigured(account),
			botTokenSource: account.botTokenSource,
			appTokenSource: account.appTokenSource
		}),
		...slackConfigAccessors
	},
	allowlist: {
		supportsScope: ({ scope }) => scope === "dm",
		readConfig: ({ cfg, accountId }) => readSlackAllowlistConfig(resolveSlackAccount({
			cfg,
			accountId
		})),
		resolveNames: async ({ cfg, accountId, entries }) => await resolveSlackAllowlistNames({
			cfg,
			accountId,
			entries
		}),
		applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
			channelId: "slack",
			normalize: ({ cfg, accountId, values }) => slackConfigAccessors.formatAllowFrom({
				cfg,
				accountId,
				allowFrom: values
			}),
			resolvePaths: (scope) => scope === "dm" ? {
				readPaths: [["allowFrom"], ["dm", "allowFrom"]],
				writePath: ["allowFrom"],
				cleanupPaths: [["dm", "allowFrom"]]
			} : null
		})
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => {
			return buildAccountScopedDmSecurityPolicy({
				cfg,
				channelKey: "slack",
				accountId,
				fallbackAccountId: account.accountId ?? "default",
				policy: account.dm?.policy,
				allowFrom: account.dm?.allowFrom ?? [],
				allowFromPathSuffix: "dm.",
				normalizeEntry: (raw) => raw.replace(/^(slack|user):/i, "")
			});
		},
		collectWarnings: ({ account, cfg }) => {
			const channelAllowlistConfigured = Boolean(account.config.channels) && Object.keys(account.config.channels ?? {}).length > 0;
			return collectOpenProviderGroupPolicyWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.slack !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				collect: (groupPolicy) => collectOpenGroupPolicyConfiguredRouteWarnings({
					groupPolicy,
					routeAllowlistConfigured: channelAllowlistConfigured,
					configureRouteAllowlist: {
						surface: "Slack channels",
						openScope: "any channel not explicitly denied",
						groupPolicyPath: "channels.slack.groupPolicy",
						routeAllowlistPath: "channels.slack.channels"
					},
					missingRouteAllowlist: {
						surface: "Slack channels",
						openBehavior: "with no channel allowlist; any channel can trigger (mention-gated)",
						remediation: "Set channels.slack.groupPolicy=\"allowlist\" and configure channels.slack.channels"
					}
				})
			});
		}
	},
	groups: {
		resolveRequireMention: resolveSlackGroupRequireMention,
		resolveToolPolicy: resolveSlackGroupToolPolicy
	},
	threading: {
		resolveReplyToMode: ({ cfg, accountId, chatType }) => resolveSlackReplyToMode(resolveSlackAccount({
			cfg,
			accountId
		}), chatType),
		allowExplicitReplyTagsWhenOff: false,
		buildToolContext: (params) => buildSlackThreadingToolContext(params),
		resolveAutoThreadId: ({ cfg, accountId, to, toolContext, replyToId }) => replyToId ? void 0 : resolveSlackAutoThreadId({
			cfg,
			accountId,
			to,
			toolContext
		}),
		resolveReplyTransport: ({ threadId, replyToId }) => ({
			replyToId: replyToId ?? (threadId != null && threadId !== "" ? String(threadId) : void 0),
			threadId: null
		})
	},
	messaging: {
		normalizeTarget: normalizeSlackMessagingTarget,
		parseExplicitTarget: ({ raw }) => parseSlackExplicitTarget(raw),
		inferTargetChatType: ({ to }) => parseSlackExplicitTarget(to)?.chatType,
		resolveOutboundSessionRoute: async (params) => await resolveSlackOutboundSessionRoute(params),
		enableInteractiveReplies: ({ cfg, accountId }) => isSlackInteractiveRepliesEnabled({
			cfg,
			accountId
		}),
		hasStructuredReplyPayload: ({ payload }) => {
			const slackData = payload.channelData?.slack;
			if (!slackData || typeof slackData !== "object" || Array.isArray(slackData)) return false;
			try {
				return Boolean(parseSlackBlocksInput(slackData.blocks)?.length);
			} catch {
				return false;
			}
		},
		targetResolver: {
			looksLikeId: looksLikeSlackTargetId,
			hint: "<channelId|user:ID|channel:ID>"
		}
	},
	directory: {
		self: async () => null,
		listPeers: async (params) => listSlackDirectoryPeersFromConfig(params),
		listGroups: async (params) => listSlackDirectoryGroupsFromConfig(params),
		listPeersLive: async (params) => getSlackRuntime().channel.slack.listDirectoryPeersLive(params),
		listGroupsLive: async (params) => getSlackRuntime().channel.slack.listDirectoryGroupsLive(params)
	},
	resolver: { resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
		const toResolvedTarget = (entry, note) => ({
			input: entry.input,
			resolved: entry.resolved,
			id: entry.id,
			name: entry.name,
			note
		});
		const account = resolveSlackAccount({
			cfg,
			accountId
		});
		const token = account.config.userToken?.trim() || account.botToken?.trim();
		if (!token) return inputs.map((input) => ({
			input,
			resolved: false,
			note: "missing Slack token"
		}));
		if (kind === "group") return (await getSlackRuntime().channel.slack.resolveChannelAllowlist({
			token,
			entries: inputs
		})).map((entry) => toResolvedTarget(entry, entry.archived ? "archived" : void 0));
		return (await getSlackRuntime().channel.slack.resolveUserAllowlist({
			token,
			entries: inputs
		})).map((entry) => toResolvedTarget(entry, entry.note));
	} },
	actions: {
		listActions: ({ cfg }) => listSlackMessageActions(cfg),
		getCapabilities: ({ cfg }) => {
			const capabilities = /* @__PURE__ */ new Set();
			if (listSlackMessageActions(cfg).includes("send")) capabilities.add("blocks");
			if (isSlackInteractiveRepliesEnabled({ cfg })) capabilities.add("interactive");
			return Array.from(capabilities);
		},
		extractToolSend: ({ args }) => extractSlackToolSend(args),
		handleAction: async (ctx) => await handleSlackMessageAction({
			providerId: meta.id,
			ctx,
			includeReadThreadId: true,
			invoke: async (action, cfg, toolContext) => await getSlackRuntime().channel.slack.handleSlackAction(action, cfg, toolContext)
		})
	},
	setup: slackSetupAdapter,
	outbound: {
		deliveryMode: "direct",
		chunker: null,
		textChunkLimit: 4e3,
		sendText: async ({ to, text, accountId, deps, replyToId, threadId, cfg }) => {
			const { send, threadTsValue, tokenOverride } = resolveSlackSendContext({
				cfg,
				accountId: accountId ?? void 0,
				deps,
				replyToId,
				threadId
			});
			return {
				channel: "slack",
				...await send(to, text, {
					cfg,
					threadTs: threadTsValue != null ? String(threadTsValue) : void 0,
					accountId: accountId ?? void 0,
					...tokenOverride ? { token: tokenOverride } : {}
				})
			};
		},
		sendMedia: async ({ to, text, mediaUrl, mediaLocalRoots, accountId, deps, replyToId, threadId, cfg }) => {
			const { send, threadTsValue, tokenOverride } = resolveSlackSendContext({
				cfg,
				accountId: accountId ?? void 0,
				deps,
				replyToId,
				threadId
			});
			return {
				channel: "slack",
				...await send(to, text, {
					cfg,
					mediaUrl,
					mediaLocalRoots,
					threadTs: threadTsValue != null ? String(threadTsValue) : void 0,
					accountId: accountId ?? void 0,
					...tokenOverride ? { token: tokenOverride } : {}
				})
			};
		}
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot, {
			botTokenSource: snapshot.botTokenSource ?? "none",
			appTokenSource: snapshot.appTokenSource ?? "none"
		}),
		probeAccount: async ({ account, timeoutMs }) => {
			const token = account.botToken?.trim();
			if (!token) return {
				ok: false,
				error: "missing token"
			};
			return await getSlackRuntime().channel.slack.probeSlack(token, timeoutMs);
		},
		formatCapabilitiesProbe: ({ probe }) => {
			const slackProbe = probe;
			const lines = [];
			if (slackProbe?.bot?.name) lines.push({ text: `Bot: @${slackProbe.bot.name}` });
			if (slackProbe?.team?.name || slackProbe?.team?.id) {
				const id = slackProbe.team?.id ? ` (${slackProbe.team.id})` : "";
				lines.push({ text: `Team: ${slackProbe.team?.name ?? "unknown"}${id}` });
			}
			return lines;
		},
		buildCapabilitiesDiagnostics: async ({ account, timeoutMs }) => {
			const lines = [];
			const details = {};
			const botToken = account.botToken?.trim();
			const userToken = account.config.userToken?.trim();
			const botScopes = botToken ? await fetchSlackScopes(botToken, timeoutMs) : {
				ok: false,
				error: "Slack bot token missing."
			};
			lines.push(formatSlackScopeDiagnostic({
				tokenType: "bot",
				result: botScopes
			}));
			details.botScopes = botScopes;
			if (userToken) {
				const userScopes = await fetchSlackScopes(userToken, timeoutMs);
				lines.push(formatSlackScopeDiagnostic({
					tokenType: "user",
					result: userScopes
				}));
				details.userScopes = userScopes;
			}
			return {
				lines,
				details
			};
		},
		buildAccountSnapshot: ({ account, runtime, probe }) => {
			const configured = ((account.config.mode ?? "socket") === "http" ? resolveConfiguredFromRequiredCredentialStatuses(account, ["botTokenStatus", "signingSecretStatus"]) : resolveConfiguredFromRequiredCredentialStatuses(account, ["botTokenStatus", "appTokenStatus"])) ?? isSlackAccountConfigured(account);
			return {
				...buildComputedAccountStatusSnapshot({
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured,
					runtime,
					probe
				}),
				...projectCredentialSnapshotFields(account)
			};
		}
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		const botToken = account.botToken?.trim();
		const appToken = account.appToken?.trim();
		ctx.log?.info(`[${account.accountId}] starting provider`);
		return getSlackRuntime().channel.slack.monitorSlackProvider({
			botToken: botToken ?? "",
			appToken: appToken ?? "",
			accountId: account.accountId,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			mediaMaxMb: account.config.mediaMaxMb,
			slashCommand: account.config.slashCommand,
			setStatus: ctx.setStatus,
			getStatus: ctx.getStatus
		});
	} }
};
//#endregion
//#region extensions/slack/index.ts
const plugin = {
	id: "slack",
	name: "Slack",
	description: "Slack channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setSlackRuntime(api.runtime);
		api.registerChannel({ plugin: slackPlugin });
	}
};
//#endregion
export { plugin as default };
