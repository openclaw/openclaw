import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-CwBWagLE.js";
import { h as stringifyRouteThreadId, o as channelRouteTargetsMatchExact } from "./channel-route-jaZFObQA.js";
import { n as isSingleUseReplyToMode } from "./reply-reference-BWpe6PiT.js";
import { c as normalizeInteractiveReply, l as normalizeMessagePresentation } from "./payload-BGXKFAMn.js";
import { r as createLazyRuntimeModule } from "./lazy-runtime-Dh47Iq4d.js";
import { _ as readStringParam, p as readNumberParam } from "./common-V7-zd73S.js";
import { t as readBooleanParam } from "./boolean-param-58y-fOZr.js";
import { n as resolveOutboundSendDep } from "./send-deps-jTRjIYIm.js";
import { t as adaptScopedAccountAccessor } from "./channel-config-helpers-Dzal6cfS.js";
import { t as buildOutboundBaseSessionKey } from "./base-session-key-Cg8jJPrg.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { i as createChatChannelPlugin, n as buildThreadAwareOutboundSessionRoute } from "./core-BPnS_bab.js";
import "./channel-core-BoAjH-Jl.js";
import "./routing-BfSZVtOk.js";
import { t as createChannelDirectoryAdapter } from "./directory-runtime-zNq6TUqB.js";
import { t as createRuntimeDirectoryLiveAdapter } from "./runtime-forwarders-9PwLMcjR.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-CU1TPzr2.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-7oBaTEgH.js";
import { i as splitChannelApprovalCapability, n as createApproverRestrictedNativeApprovalCapability } from "./approval-delivery-helpers-r2x60VIQ.js";
import "./approval-delivery-runtime-DjTfaYTN.js";
import { n as createLazyChannelApprovalNativeRuntimeAdapter } from "./approval-handler-adapter-runtime-DG5nC6uH.js";
import { n as resolveApprovalRequestSessionConversation } from "./exec-approval-session-target-BSr7uNdj.js";
import { n as createChannelNativeOriginTargetResolver, t as createChannelApproverDmTargetResolver } from "./approval-native-helpers-DMOyjxog.js";
import "./approval-native-runtime-Bm65xYGS.js";
import { o as resolveConfiguredFromRequiredCredentialStatuses, r as projectCredentialSnapshotFields } from "./account-snapshot-fields-C13MnFmj.js";
import "./reply-reference-B2sOmJ2G.js";
import { o as createAccountScopedAllowlistNameResolver, r as buildLegacyDmAccountAllowlistAdapter, s as createFlatAllowlistOverrideResolver } from "./allowlist-config-edit-DAOnqNNq.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./pairing-message-C5_Dm1pD.js";
import { d as createDefaultChannelRuntimeState, u as createComputedAccountStatusAdapter } from "./status-helpers-Dk-3BT6p.js";
import { k as createChannelMessageAdapterFromOutbound } from "./channel-message-CmG6T1ry.js";
import { i as createPairingPrefixStripper } from "./channel-pairing--8umY0wm.js";
import { i as createAttachedChannelResultAdapter } from "./channel-send-result-CJR0gRri.js";
import "./param-readers-CEKHiUCI.js";
import { a as resolveSlackAccount, i as resolveDefaultSlackAccountId, l as resolveSlackReplyToMode, n as listSlackAccountIds, o as resolveSlackAccountAllowFrom } from "./accounts-Ba1LnRZV.js";
import { i as resolveSlackChannelId, n as normalizeSlackMessagingTarget, r as parseSlackTarget, t as looksLikeSlackTargetId } from "./target-parsing-V_XPO9_R.js";
import { a as normalizeSlackApproverId, c as shouldSuppressLocalSlackExecApprovalPrompt, i as isSlackExecApprovalClientEnabled, o as resolveSlackExecApprovalTarget, r as isSlackExecApprovalAuthorizedSender, s as shouldHandleSlackExecApprovalRequest, t as getSlackExecApprovalApprovers } from "./exec-approvals-DNT770yC.js";
import { n as buildSlackPresentationBlocks, r as resolveSlackInteractiveBlockOffsets, t as buildSlackInteractiveBlocks } from "./blocks-render-KRq-hLT2.js";
import { n as resolveSlackThreadTsValue, r as SLACK_TEXT_LIMIT, t as normalizeSlackThreadTsCandidate } from "./thread-ts-DWLXPVhT.js";
import { n as extractSlackToolSend, t as describeSlackMessageTool } from "./message-tool-api-D5I2ue75.js";
import { n as isSlackInteractiveRepliesEnabled, t as compileSlackInteractiveReplies } from "./interactive-replies-DNuhlh3P.js";
import "./channel-api-ByraXVye.js";
import { r as createSlackWebClient } from "./client-BY5LT_WB.js";
import { r as normalizeAllowListLower } from "./allow-list-NJrZzx1V.js";
import { n as resolveSlackGroupToolPolicy, t as resolveSlackGroupRequireMention } from "./group-policy-jOnVDIiw.js";
import { t as resolveSlackReplyBlocks } from "./reply-blocks-VBmaHhOr.js";
import { t as getOptionalSlackRuntime } from "./runtime-NCLMlJ1a.js";
import { i as slackSecurityAdapter, n as isSlackPluginAccountConfigured, r as slackConfigAdapter, t as createSlackPluginBase } from "./shared-C6EpakPw.js";
import { i as SLACK_CHANNEL, n as createSlackSetupWizardProxy, r as slackSetupAdapter } from "./setup-core-VYPiralZ.js";
//#region extensions/slack/src/action-threading.ts
function resolveSlackAutoThreadId(params) {
	const context = params.toolContext;
	if (!context?.currentThreadTs || !context.currentChannelId) return;
	if (context.replyToMode !== "all" && !isSingleUseReplyToMode(context.replyToMode ?? "off")) return;
	const parsedTarget = parseSlackTarget(params.to, { defaultKind: "channel" });
	if (!parsedTarget || parsedTarget.kind !== "channel") return;
	if (normalizeLowercaseStringOrEmpty(parsedTarget.id) !== normalizeLowercaseStringOrEmpty(context.currentChannelId)) return;
	if (isSingleUseReplyToMode(context.replyToMode ?? "off") && context.hasRepliedRef?.value) return;
	return context.currentThreadTs;
}
//#endregion
//#region extensions/slack/src/approval-auth.ts
function getSlackApprovalApprovers(params) {
	const account = resolveSlackAccount(params).config;
	return resolveApprovalApprovers({
		allowFrom: resolveSlackAccountAllowFrom(params),
		defaultTo: account.defaultTo,
		normalizeApprover: normalizeSlackApproverId,
		normalizeDefaultTo: normalizeSlackApproverId
	});
}
function isSlackApprovalAuthorizedSender(params) {
	const senderId = params.senderId ? normalizeSlackApproverId(params.senderId) : void 0;
	if (!senderId) return false;
	return getSlackApprovalApprovers(params).includes(senderId);
}
createResolvedApproverActionAuthAdapter({
	channelLabel: "Slack",
	resolveApprovers: ({ cfg, accountId }) => getSlackApprovalApprovers({
		cfg,
		accountId
	}),
	normalizeSenderId: (value) => normalizeSlackApproverId(value)
});
//#endregion
//#region extensions/slack/src/approval-native.ts
function extractSlackSessionKind(sessionKey) {
	if (!sessionKey) return null;
	const kind = normalizeLowercaseStringOrEmpty(sessionKey.match(/slack:(direct|channel|group):/i)?.[1]);
	return kind ? kind : null;
}
function normalizeComparableTarget(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function normalizeSlackThreadMatchKey(threadId) {
	const trimmed = threadId?.trim();
	if (!trimmed) return "";
	return trimmed.match(/^\d+/)?.[0] ?? trimmed;
}
function resolveTurnSourceSlackOriginTarget(request) {
	const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
	const turnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
	if (turnSourceChannel !== "slack" || !turnSourceTo) return null;
	const parsed = parseSlackTarget(turnSourceTo, { defaultKind: extractSlackSessionKind(request.request.sessionKey ?? void 0) === "direct" ? "user" : "channel" });
	if (!parsed) return null;
	const threadId = stringifyRouteThreadId(request.request.turnSourceThreadId);
	return {
		to: `${parsed.kind}:${parsed.id}`,
		threadId
	};
}
function resolveSessionSlackOriginTarget(sessionTarget) {
	return {
		to: sessionTarget.to,
		threadId: stringifyRouteThreadId(sessionTarget.threadId)
	};
}
function resolveSlackFallbackOriginTarget(request) {
	const sessionTarget = resolveApprovalRequestSessionConversation({
		request,
		channel: "slack",
		bundledFallback: false
	});
	if (!sessionTarget) return null;
	const parsed = parseSlackTarget(sessionTarget.id.toUpperCase(), { defaultKind: "channel" });
	if (!parsed) return null;
	return {
		to: `${parsed.kind}:${parsed.id}`,
		threadId: sessionTarget.threadId
	};
}
function normalizeSlackOriginTarget(target) {
	return {
		...target,
		to: normalizeComparableTarget(target.to)
	};
}
function slackTargetsMatch(a, b) {
	return channelRouteTargetsMatchExact({
		left: {
			channel: "slack",
			to: a.to
		},
		right: {
			channel: "slack",
			to: b.to
		}
	}) && normalizeSlackThreadMatchKey(a.threadId) === normalizeSlackThreadMatchKey(b.threadId);
}
const slackApprovalCapability = createApproverRestrictedNativeApprovalCapability({
	channel: "slack",
	channelLabel: "Slack",
	describeExecApprovalSetup: ({ accountId }) => {
		const prefix = accountId && accountId !== "default" ? `channels.slack.accounts.${accountId}` : "channels.slack";
		return `Approve it from the Web UI or terminal UI for now. Slack supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
	},
	listAccountIds: listSlackAccountIds,
	hasApprovers: ({ cfg, accountId }) => getSlackExecApprovalApprovers({
		cfg,
		accountId
	}).length > 0,
	isExecAuthorizedSender: ({ cfg, accountId, senderId }) => isSlackExecApprovalAuthorizedSender({
		cfg,
		accountId,
		senderId
	}),
	isPluginAuthorizedSender: ({ cfg, accountId, senderId }) => isSlackApprovalAuthorizedSender({
		cfg,
		accountId,
		senderId
	}),
	isNativeDeliveryEnabled: ({ cfg, accountId }) => isSlackExecApprovalClientEnabled({
		cfg,
		accountId
	}),
	resolveNativeDeliveryMode: ({ cfg, accountId }) => resolveSlackExecApprovalTarget({
		cfg,
		accountId
	}),
	requireMatchingTurnSourceChannel: true,
	resolveSuppressionAccountId: ({ target, request }) => normalizeOptionalString(target.accountId) ?? normalizeOptionalString(request.request.turnSourceAccountId),
	resolveOriginTarget: createChannelNativeOriginTargetResolver({
		channel: "slack",
		shouldHandleRequest: ({ cfg, accountId, request }) => shouldHandleSlackExecApprovalRequest({
			cfg,
			accountId,
			request
		}),
		resolveTurnSourceTarget: resolveTurnSourceSlackOriginTarget,
		resolveSessionTarget: resolveSessionSlackOriginTarget,
		normalizeTargetForMatch: normalizeSlackOriginTarget,
		targetsMatch: slackTargetsMatch,
		resolveFallbackTarget: resolveSlackFallbackOriginTarget
	}),
	resolveApproverDmTargets: createChannelApproverDmTargetResolver({
		shouldHandleRequest: ({ cfg, accountId, request }) => shouldHandleSlackExecApprovalRequest({
			cfg,
			accountId,
			request
		}),
		resolveApprovers: getSlackExecApprovalApprovers,
		mapApprover: (approver) => ({ to: `user:${approver}` })
	}),
	notifyOriginWhenDmOnly: true,
	nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
		eventKinds: ["exec"],
		isConfigured: ({ cfg, accountId }) => isSlackExecApprovalClientEnabled({
			cfg,
			accountId
		}),
		shouldHandle: ({ cfg, accountId, request }) => shouldHandleSlackExecApprovalRequest({
			cfg,
			accountId,
			request
		}),
		load: async () => (await import("./approval-handler.runtime-B19FTNqc.js")).slackApprovalNativeRuntime
	})
});
splitChannelApprovalCapability(slackApprovalCapability);
//#endregion
//#region extensions/slack/src/message-action-dispatch.ts
/** Translate generic channel action requests into Slack-specific tool invocations and payload shapes. */
async function handleSlackMessageAction(params) {
	const { providerId, ctx, invoke, normalizeChannelId, includeReadThreadId = false } = params;
	const { action, cfg, params: actionParams } = ctx;
	const accountId = ctx.accountId ?? void 0;
	const resolveChannelId = () => {
		const channelId = readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to", { required: true });
		return normalizeChannelId ? normalizeChannelId(channelId) : channelId;
	};
	if (action === "send") {
		const to = readStringParam(actionParams, "to", { required: true });
		const content = readStringParam(actionParams, "message", {
			required: false,
			allowEmpty: true
		});
		const mediaUrl = readStringParam(actionParams, "media", { trim: false });
		const presentation = normalizeMessagePresentation(actionParams.presentation);
		const interactive = normalizeInteractiveReply(actionParams.interactive);
		const presentationBlocks = presentation ? buildSlackPresentationBlocks(presentation) : void 0;
		const interactiveBlocks = interactive ? buildSlackInteractiveBlocks(interactive, resolveSlackInteractiveBlockOffsets(presentationBlocks)) : void 0;
		const mergedBlocks = [...presentationBlocks ?? [], ...interactiveBlocks ?? []];
		const blocks = mergedBlocks.length > 0 ? mergedBlocks : void 0;
		if (!content && !mediaUrl && !blocks) throw new Error("Slack send requires message, blocks, or media.");
		const replyBroadcast = readBooleanParam(actionParams, "replyBroadcast");
		if (replyBroadcast && mediaUrl) throw new Error("Slack replyBroadcast is only supported for text or block thread replies.");
		const threadId = readStringParam(actionParams, "threadId");
		const replyTo = readStringParam(actionParams, "replyTo");
		const topLevel = readBooleanParam(actionParams, "topLevel") === true || actionParams.threadId === null;
		return await invoke({
			action: "sendMessage",
			to,
			content: content ?? "",
			mediaUrl: mediaUrl ?? void 0,
			accountId,
			threadTs: threadId ?? replyTo ?? void 0,
			...topLevel ? { topLevel: true } : {},
			...replyBroadcast ? { replyBroadcast } : {},
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
			messageId: readStringParam(actionParams, "messageId"),
			accountId
		};
		if (includeReadThreadId) readAction.threadId = readStringParam(actionParams, "threadId");
		return await invoke(readAction, cfg);
	}
	if (action === "edit") {
		const messageId = readStringParam(actionParams, "messageId", { required: true });
		const content = readStringParam(actionParams, "message", { allowEmpty: true });
		const presentation = normalizeMessagePresentation(actionParams.presentation);
		const blocks = presentation ? buildSlackPresentationBlocks(presentation) : void 0;
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
		const fileIdParam = readStringParam(actionParams, "fileId");
		const messageIdParam = readStringParam(actionParams, "messageId") ?? readStringParam(actionParams, "message_id");
		if (!fileIdParam && messageIdParam) throw new Error("download-file requires fileId (the Slack file id, for example F0B0LTT8M36 from event.files[].id), not messageId. Did you mean to pass fileId? messageId is the Slack message timestamp and is used by react / reactions / edit / delete / pin / unpin actions, not download-file.");
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
	if (action === "upload-file") {
		if (readBooleanParam(actionParams, "replyBroadcast")) throw new Error("Slack replyBroadcast is only supported for text or block thread replies.");
		const to = readStringParam(actionParams, "to") ?? resolveChannelId();
		const filePath = readStringParam(actionParams, "filePath", { trim: false }) ?? readStringParam(actionParams, "path", { trim: false }) ?? readStringParam(actionParams, "media", { trim: false });
		if (!filePath) throw new Error("upload-file requires filePath, path, or media");
		const threadId = readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo");
		const topLevel = readBooleanParam(actionParams, "topLevel") === true || actionParams.threadId === null;
		return await invoke({
			action: "uploadFile",
			to,
			filePath,
			initialComment: readStringParam(actionParams, "initialComment", { allowEmpty: true }) ?? readStringParam(actionParams, "message", { allowEmpty: true }) ?? "",
			filename: readStringParam(actionParams, "filename"),
			title: readStringParam(actionParams, "title"),
			threadTs: threadId ?? void 0,
			...topLevel ? { topLevel: true } : {},
			accountId
		}, cfg, ctx.toolContext);
	}
	throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
//#endregion
//#region extensions/slack/src/channel-actions.ts
let slackActionRuntimePromise$1;
async function loadSlackActionRuntime$1() {
	slackActionRuntimePromise$1 ??= import("./action-runtime.runtime.js");
	return await slackActionRuntimePromise$1;
}
function resolveSlackActionContext(params) {
	if (!params.toolContext && !params.mediaLocalRoots && !params.mediaReadFile) return;
	return {
		...params.toolContext,
		...params.mediaLocalRoots ? { mediaLocalRoots: params.mediaLocalRoots } : {},
		...params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}
	};
}
function createSlackActions(providerId, options) {
	return {
		describeMessageTool: describeSlackMessageTool,
		extractToolSend: ({ args }) => extractSlackToolSend(args),
		prepareSendPayload: ({ ctx, payload }) => ctx.action === "send" ? payload : null,
		handleAction: async (ctx) => {
			return await handleSlackMessageAction({
				providerId,
				ctx,
				normalizeChannelId: resolveSlackChannelId,
				includeReadThreadId: true,
				invoke: async (action, cfg, toolContext) => {
					const actionContext = resolveSlackActionContext({
						toolContext,
						mediaLocalRoots: ctx.mediaLocalRoots,
						mediaReadFile: ctx.mediaReadFile
					});
					return await (options?.invoke ? options.invoke(action, cfg, actionContext) : (await loadSlackActionRuntime$1()).handleSlackAction(action, cfg, actionContext));
				}
			});
		}
	};
}
//#endregion
//#region extensions/slack/src/channel-type.ts
const SLACK_CONVERSATION_INFO_CACHE = /* @__PURE__ */ new Map();
async function resolveSlackConversationInfo(params) {
	const channelId = params.channelId.trim();
	if (!channelId) return { type: "unknown" };
	const account = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const cacheKey = `${account.accountId}:${channelId}`;
	const cached = SLACK_CONVERSATION_INFO_CACHE.get(cacheKey);
	if (cached) return cached;
	const isNativeImChannel = /^D/i.test(channelId);
	const groupChannels = normalizeAllowListLower(account.dm?.groupChannels);
	const channelIdLower = normalizeLowercaseStringOrEmpty(channelId);
	if (!isNativeImChannel && (groupChannels.includes(channelIdLower) || groupChannels.includes(`slack:${channelIdLower}`) || groupChannels.includes(`channel:${channelIdLower}`) || groupChannels.includes(`group:${channelIdLower}`) || groupChannels.includes(`mpim:${channelIdLower}`))) {
		const result = { type: "group" };
		SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
		return result;
	}
	const channelKeys = Object.keys(account.channels ?? {});
	if (!isNativeImChannel && channelKeys.some((key) => {
		const normalized = normalizeLowercaseStringOrEmpty(key);
		return normalized === channelIdLower || normalized === `channel:${channelIdLower}` || normalized.replace(/^#/, "") === channelIdLower;
	})) {
		const result = { type: "channel" };
		SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
		return result;
	}
	const token = normalizeOptionalString(account.botToken) ?? normalizeOptionalString(account.config.userToken) ?? "";
	if (!token) {
		const result = { type: isNativeImChannel ? "dm" : "unknown" };
		if (!isNativeImChannel) SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
		return result;
	}
	try {
		const client = createSlackWebClient(token);
		if (isNativeImChannel) {
			const opened = await client.conversations.open({
				channel: channelId,
				prevent_creation: true,
				return_im: true
			});
			const user = typeof opened.channel?.user === "string" && opened.channel.user.trim() ? opened.channel.user.trim() : void 0;
			const result = user ? {
				type: "dm",
				user
			} : { type: "dm" };
			if (user) SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
			return result;
		}
		const channel = (await client.conversations.info({ channel: channelId })).channel;
		const result = { type: channel?.is_im ? "dm" : channel?.is_mpim ? "group" : "channel" };
		SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
		return result;
	} catch {
		const result = { type: isNativeImChannel ? "dm" : "unknown" };
		if (!isNativeImChannel) SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
		return result;
	}
}
async function resolveSlackChannelType(params) {
	return (await resolveSlackConversationInfo(params)).type;
}
function __resetSlackChannelTypeCacheForTest() {
	SLACK_CONVERSATION_INFO_CACHE.clear();
}
//#endregion
//#region extensions/slack/src/threading-tool-context.ts
function buildSlackThreadingToolContext(params) {
	const configuredReplyToMode = resolveSlackReplyToMode(resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}), params.context.ChatType);
	const effectiveReplyToMode = params.context.MessageThreadId != null ? "all" : configuredReplyToMode;
	const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
	return {
		currentChannelId: params.context.To?.startsWith("channel:") ? params.context.To.slice(8) : normalizeOptionalString(params.context.NativeChannelId),
		currentThreadTs: normalizeSlackThreadTsCandidate(threadId),
		replyToMode: effectiveReplyToMode,
		hasRepliedRef: params.hasRepliedRef
	};
}
//#endregion
//#region extensions/slack/src/channel.ts
const EXTENSION_SHARED_MODULE_ID = "openclaw/plugin-sdk/extension-shared";
const TARGET_RESOLVER_RUNTIME_MODULE_ID = "openclaw/plugin-sdk/target-resolver-runtime";
const loadExtensionSharedSdk = createLazyRuntimeModule(() => import(EXTENSION_SHARED_MODULE_ID));
const loadTargetResolverRuntimeSdk = createLazyRuntimeModule(() => import(TARGET_RESOLVER_RUNTIME_MODULE_ID));
const loadSlackSetupSurfaceModule = createLazyRuntimeModule(() => import("./setup-surface-BHnaIDBr.js"));
const loadSlackScopesModule = createLazyRuntimeModule(() => import("./scopes-CZH3MfOe.js"));
const loadSlackOutboundAdapterModule = createLazyRuntimeModule(() => import("./outbound-adapter-C_kTeiGp.js"));
async function resolveSlackHandleAction() {
	return getOptionalSlackRuntime()?.channel?.slack?.handleSlackAction ?? (await loadSlackActionRuntime()).handleSlackAction;
}
function shouldTreatSlackDeliveredTextAsVisible(params) {
	return params.kind === "block" && typeof params.text === "string" && params.text.trim().length > 0;
}
function getTokenForOperation(account, operation) {
	const userToken = normalizeOptionalString(account.config.userToken);
	const botToken = normalizeOptionalString(account.botToken);
	const allowUserWrites = account.config.userTokenReadOnly === false;
	if (operation === "read") return userToken ?? botToken;
	if (!allowUserWrites) return botToken;
	return botToken ?? userToken;
}
let slackActionRuntimePromise;
let slackSendRuntimePromise;
let slackProbeModulePromise;
let slackMonitorModulePromise;
let slackDirectoryLiveModulePromise;
const loadSlackDirectoryConfigModule = createLazyRuntimeModule(() => import("./directory-config-Bcm8qe5o.js"));
const loadSlackResolveChannelsModule = createLazyRuntimeModule(() => import("./resolve-channels-D7LK01Vn.js"));
const loadSlackResolveUsersModule = createLazyRuntimeModule(() => import("./resolve-users-B6LLNtRv.js"));
async function loadSlackActionRuntime() {
	slackActionRuntimePromise ??= import("./action-runtime.runtime.js");
	return await slackActionRuntimePromise;
}
async function loadSlackSendRuntime() {
	slackSendRuntimePromise ??= import("./send.runtime-BmX7iBJi.js");
	return await slackSendRuntimePromise;
}
async function loadSlackProbeModule() {
	slackProbeModulePromise ??= import("./probe-Dead0C87.js");
	return await slackProbeModulePromise;
}
async function loadSlackMonitorModule() {
	slackMonitorModulePromise ??= import("./monitor-BB_I6_Nd.js");
	return await slackMonitorModulePromise;
}
async function loadSlackDirectoryLiveModule() {
	slackDirectoryLiveModulePromise ??= import("./directory-live-D5vhT7H7.js");
	return await slackDirectoryLiveModulePromise;
}
async function resolveSlackSendContext(params) {
	const send = resolveOutboundSendDep(params.deps, "slack") ?? (await loadSlackSendRuntime()).sendMessageSlack;
	const account = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const token = getTokenForOperation(account, "write");
	const botToken = account.botToken?.trim();
	const tokenOverride = token && token !== botToken ? token : void 0;
	return {
		send,
		threadTsValue: resolveSlackThreadTsValue(params),
		tokenOverride
	};
}
function parseSlackExplicitTarget(raw) {
	const target = parseSlackTarget(raw, { defaultKind: "channel" });
	if (!target) return null;
	return {
		to: target.id,
		chatType: target.kind === "user" ? "direct" : "channel"
	};
}
function normalizeSlackAcpConversationId(raw) {
	const trimmed = normalizeOptionalString(raw);
	if (!trimmed) return null;
	const conversationId = normalizeLowercaseStringOrEmpty(parseSlackTarget(trimmed, { defaultKind: "channel" })?.id ?? trimmed.replace(/^slack:/i, "").replace(/^(?:channel|group|direct|user):/i, ""));
	return conversationId ? { conversationId } : null;
}
function matchSlackAcpConversation(params) {
	const bindingConversationId = normalizeSlackAcpConversationId(params.bindingConversationId)?.conversationId;
	const conversationId = normalizeSlackAcpConversationId(params.conversationId)?.conversationId;
	const parentConversationId = normalizeSlackAcpConversationId(params.parentConversationId)?.conversationId;
	if (!bindingConversationId || !conversationId) return null;
	if (bindingConversationId === conversationId) return {
		conversationId,
		matchPriority: 2
	};
	if (parentConversationId && parentConversationId !== conversationId && bindingConversationId === parentConversationId) return {
		conversationId: parentConversationId,
		matchPriority: 1
	};
	return null;
}
function buildSlackBaseSessionKey(params) {
	return buildOutboundBaseSessionKey({
		...params,
		channel: "slack"
	});
}
function shouldRecoverSlackThreadFromCurrentSession(params) {
	if (params.peerKind === "direct" && (params.cfg.session?.dmScope ?? "main") === "main") return false;
	return true;
}
async function resolveSlackOutboundSessionRoute(params) {
	const parsed = parseSlackTarget(params.target, { defaultKind: "channel" });
	if (!parsed) return null;
	const isDm = parsed.kind === "user";
	let peerKind = isDm ? "direct" : "channel";
	let peerId = parsed.id;
	if (!isDm && /^D/i.test(parsed.id)) {
		const conversation = await resolveSlackConversationInfo({
			cfg: params.cfg,
			accountId: params.accountId,
			channelId: parsed.id
		});
		if (conversation.type !== "dm" || !conversation.user) return null;
		peerKind = "direct";
		peerId = conversation.user;
	} else if (!isDm && /^G/i.test(parsed.id)) {
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
		id: peerId
	};
	const baseSessionKey = buildSlackBaseSessionKey({
		cfg: params.cfg,
		agentId: params.agentId,
		accountId: params.accountId,
		peer
	});
	return buildThreadAwareOutboundSessionRoute({
		route: {
			sessionKey: baseSessionKey,
			baseSessionKey,
			peer,
			chatType: peerKind === "direct" ? "direct" : "channel",
			from: peerKind === "direct" ? `slack:${peerId}` : peerKind === "group" ? `slack:group:${peerId}` : `slack:channel:${peerId}`,
			to: peerKind === "direct" ? `user:${peerId}` : `channel:${peerId}`
		},
		replyToId: params.replyToId,
		threadId: params.threadId,
		currentSessionKey: params.currentSessionKey,
		canRecoverCurrentThread: () => shouldRecoverSlackThreadFromCurrentSession({
			cfg: params.cfg,
			peerKind
		})
	});
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
const resolveSlackAllowlistGroupOverrides = createFlatAllowlistOverrideResolver({
	resolveRecord: (account) => account.channels,
	label: (key) => key,
	resolveEntries: (value) => value?.users
});
const resolveSlackAllowlistNames = createAccountScopedAllowlistNameResolver({
	resolveAccount: resolveSlackAccount,
	resolveToken: (account) => normalizeOptionalString(account.config.userToken) ?? normalizeOptionalString(account.botToken),
	resolveNames: async ({ token, entries }) => (await loadSlackResolveUsersModule()).resolveSlackUserAllowlist({
		token,
		entries
	})
});
const slackChannelOutbound = {
	deliveryMode: "direct",
	chunker: null,
	textChunkLimit: SLACK_TEXT_LIMIT,
	normalizePayload: ({ payload, cfg, accountId }) => isSlackInteractiveRepliesEnabled({
		cfg,
		accountId
	}) ? compileSlackInteractiveReplies(payload) : payload,
	deliveryCapabilities: { durableFinal: {
		text: true,
		media: true,
		payload: true,
		replyTo: true,
		thread: true,
		messageSendingHooks: true
	} },
	shouldTreatDeliveredTextAsVisible: shouldTreatSlackDeliveredTextAsVisible,
	shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload }) => shouldSuppressLocalSlackExecApprovalPrompt({
		cfg,
		accountId,
		payload
	}),
	sendPayload: async (ctx) => {
		const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
			cfg: ctx.cfg,
			accountId: ctx.accountId ?? void 0,
			deps: ctx.deps,
			replyToId: ctx.replyToId,
			threadId: ctx.threadId
		});
		const { slackOutbound } = await loadSlackOutboundAdapterModule();
		return await slackOutbound.sendPayload({
			...ctx,
			replyToId: threadTsValue,
			threadId: null,
			deps: {
				...ctx.deps,
				slack: async (to, text, opts) => await send(to, text, {
					...opts,
					...tokenOverride ? { token: tokenOverride } : {}
				})
			}
		});
	},
	...createAttachedChannelResultAdapter({
		channel: "slack",
		sendText: async ({ to, text, accountId, deps, replyToId, threadId, cfg }) => {
			const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
				cfg,
				accountId: accountId ?? void 0,
				deps,
				replyToId,
				threadId
			});
			return await send(to, text, {
				cfg,
				threadTs: threadTsValue,
				accountId: accountId ?? void 0,
				...tokenOverride ? { token: tokenOverride } : {}
			});
		},
		sendMedia: async ({ to, text, mediaUrl, mediaLocalRoots, accountId, deps, replyToId, threadId, cfg }) => {
			const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
				cfg,
				accountId: accountId ?? void 0,
				deps,
				replyToId,
				threadId
			});
			return await send(to, text, {
				cfg,
				mediaUrl,
				mediaLocalRoots,
				threadTs: threadTsValue,
				accountId: accountId ?? void 0,
				...tokenOverride ? { token: tokenOverride } : {}
			});
		}
	})
};
const slackMessageAdapter = createChannelMessageAdapterFromOutbound({
	id: "slack",
	outbound: slackChannelOutbound,
	live: {
		capabilities: {
			draftPreview: true,
			previewFinalization: true,
			progressUpdates: true,
			nativeStreaming: true
		},
		finalizer: { capabilities: {
			finalEdit: true,
			normalFallback: true,
			discardPending: true
		} }
	}
});
const slackPlugin = createChatChannelPlugin({
	base: {
		...createSlackPluginBase({
			setupWizard: createSlackSetupWizardProxy(loadSlackSetupSurfaceModule),
			setup: slackSetupAdapter
		}),
		allowlist: {
			...buildLegacyDmAccountAllowlistAdapter({
				channelId: "slack",
				resolveAccount: resolveSlackAccount,
				normalize: ({ cfg, accountId, values }) => slackConfigAdapter.formatAllowFrom({
					cfg,
					accountId,
					allowFrom: values
				}),
				resolveDmAllowFrom: (account, { cfg }) => resolveSlackAccountAllowFrom({
					cfg,
					accountId: account.accountId
				}),
				resolveGroupPolicy: (account) => account.groupPolicy,
				resolveGroupOverrides: resolveSlackAllowlistGroupOverrides
			}),
			resolveNames: resolveSlackAllowlistNames
		},
		approvalCapability: slackApprovalCapability,
		groups: {
			resolveRequireMention: resolveSlackGroupRequireMention,
			resolveToolPolicy: resolveSlackGroupToolPolicy
		},
		bindings: {
			compileConfiguredBinding: ({ conversationId }) => normalizeSlackAcpConversationId(conversationId),
			matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => matchSlackAcpConversation({
				bindingConversationId: compiledBinding.conversationId,
				conversationId,
				parentConversationId
			})
		},
		messaging: {
			targetPrefixes: ["slack"],
			normalizeTarget: normalizeSlackMessagingTarget,
			resolveDeliveryTarget: ({ conversationId, parentConversationId }) => {
				const parent = parentConversationId?.trim();
				const child = conversationId.trim();
				return parent && parent !== child ? {
					to: `channel:${parent}`,
					threadId: child
				} : { to: normalizeSlackMessagingTarget(`channel:${child}`) };
			},
			resolveSessionTarget: ({ id }) => normalizeSlackMessagingTarget(`channel:${id}`),
			parseExplicitTarget: ({ raw }) => parseSlackExplicitTarget(raw),
			inferTargetChatType: ({ to }) => parseSlackExplicitTarget(to)?.chatType,
			resolveOutboundSessionRoute: async (params) => await resolveSlackOutboundSessionRoute(params),
			transformReplyPayload: ({ payload, cfg, accountId }) => isSlackInteractiveRepliesEnabled({
				cfg,
				accountId
			}) ? compileSlackInteractiveReplies(payload) : payload,
			enableInteractiveReplies: ({ cfg, accountId }) => isSlackInteractiveRepliesEnabled({
				cfg,
				accountId
			}),
			hasStructuredReplyPayload: ({ payload }) => {
				try {
					return Boolean(resolveSlackReplyBlocks(payload)?.length);
				} catch {
					return false;
				}
			},
			targetResolver: {
				looksLikeId: looksLikeSlackTargetId,
				hint: "<channelId|user:ID|channel:ID>",
				resolveTarget: async ({ input }) => {
					const parsed = parseSlackExplicitTarget(input);
					if (!parsed) return null;
					return {
						to: parsed.to,
						kind: parsed.chatType === "direct" ? "user" : "group",
						source: "normalized"
					};
				}
			}
		},
		directory: createChannelDirectoryAdapter({
			listPeers: async (params) => (await loadSlackDirectoryConfigModule()).listSlackDirectoryPeersFromConfig(params),
			listGroups: async (params) => (await loadSlackDirectoryConfigModule()).listSlackDirectoryGroupsFromConfig(params),
			...createRuntimeDirectoryLiveAdapter({
				getRuntime: loadSlackDirectoryLiveModule,
				self: (runtime) => runtime.getSlackDirectorySelfLive,
				listPeersLive: (runtime) => runtime.listSlackDirectoryPeersLive,
				listGroupsLive: (runtime) => runtime.listSlackDirectoryGroupsLive
			})
		}),
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
			const { resolveTargetsWithOptionalToken } = await loadTargetResolverRuntimeSdk();
			if (kind === "group") return resolveTargetsWithOptionalToken({
				token: normalizeOptionalString(account.config.userToken) ?? normalizeOptionalString(account.botToken),
				inputs,
				missingTokenNote: "missing Slack token",
				resolveWithToken: async ({ token, inputs }) => (await loadSlackResolveChannelsModule()).resolveSlackChannelAllowlist({
					token,
					entries: inputs
				}),
				mapResolved: (entry) => toResolvedTarget(entry, entry.archived ? "archived" : void 0)
			});
			return resolveTargetsWithOptionalToken({
				token: normalizeOptionalString(account.config.userToken) ?? normalizeOptionalString(account.botToken),
				inputs,
				missingTokenNote: "missing Slack token",
				resolveWithToken: async ({ token, inputs }) => (await loadSlackResolveUsersModule()).resolveSlackUserAllowlist({
					token,
					entries: inputs
				}),
				mapResolved: (entry) => toResolvedTarget(entry, entry.note)
			});
		} },
		actions: createSlackActions(SLACK_CHANNEL, { invoke: async (action, cfg, toolContext) => await (await resolveSlackHandleAction())(action, cfg, toolContext) }),
		message: slackMessageAdapter,
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			buildChannelSummary: async ({ snapshot }) => {
				const { buildPassiveProbedChannelStatusSummary } = await loadExtensionSharedSdk();
				return buildPassiveProbedChannelStatusSummary(snapshot, {
					botTokenSource: snapshot.botTokenSource ?? "none",
					appTokenSource: snapshot.appTokenSource ?? "none"
				});
			},
			probeAccount: async ({ account, timeoutMs }) => {
				const token = account.botToken?.trim();
				if (!token) return {
					ok: false,
					error: "missing token"
				};
				return await (await loadSlackProbeModule()).probeSlack(token, timeoutMs);
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
				const { fetchSlackScopes } = await loadSlackScopesModule();
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
			resolveAccountSnapshot: ({ account }) => {
				const configured = ((account.config.mode ?? "socket") === "http" ? resolveConfiguredFromRequiredCredentialStatuses(account, ["botTokenStatus", "signingSecretStatus"]) : resolveConfiguredFromRequiredCredentialStatuses(account, ["botTokenStatus", "appTokenStatus"])) ?? isSlackPluginAccountConfigured(account);
				return {
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured,
					extra: { ...projectCredentialSnapshotFields(account) }
				};
			}
		}),
		gateway: { startAccount: async (ctx) => {
			const account = ctx.account;
			const botToken = account.botToken?.trim();
			const appToken = account.appToken?.trim();
			ctx.log?.info(`[${account.accountId}] starting provider`);
			return (await loadSlackMonitorModule()).monitorSlackProvider({
				botToken: botToken ?? "",
				appToken: appToken ?? "",
				accountId: account.accountId,
				config: ctx.cfg,
				runtime: ctx.runtime,
				channelRuntime: ctx.channelRuntime,
				abortSignal: ctx.abortSignal,
				mediaMaxMb: account.config.mediaMaxMb,
				slashCommand: account.config.slashCommand,
				setStatus: ctx.setStatus,
				getStatus: ctx.getStatus
			});
		} },
		mentions: { stripPatterns: () => ["<@[^>\\s]+>"] }
	},
	pairing: { text: {
		idLabel: "slackUserId",
		message: PAIRING_APPROVED_MESSAGE,
		normalizeAllowEntry: createPairingPrefixStripper(/^(slack|user):/i),
		notify: async ({ cfg, id, message }) => {
			const account = resolveSlackAccount({
				cfg,
				accountId: resolveDefaultSlackAccountId(cfg)
			});
			const { sendMessageSlack } = await loadSlackSendRuntime();
			const token = getTokenForOperation(account, "write");
			await sendMessageSlack(`user:${id}`, message, {
				cfg,
				accountId: account.accountId,
				...token ? { token } : {}
			});
		}
	} },
	security: slackSecurityAdapter,
	threading: {
		scopedAccountReplyToMode: {
			resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
			resolveReplyToMode: (account, chatType) => resolveSlackReplyToMode(account, chatType)
		},
		allowExplicitReplyTagsWhenOff: false,
		buildToolContext: (params) => buildSlackThreadingToolContext(params),
		resolveAutoThreadId: ({ to, toolContext, replyToId }) => normalizeSlackThreadTsCandidate(replyToId) ? void 0 : normalizeSlackThreadTsCandidate(resolveSlackAutoThreadId({
			to,
			toolContext
		})),
		resolveReplyTransport: ({ threadId, replyToId }) => ({
			replyToId: resolveSlackThreadTsValue({
				replyToId,
				threadId
			}),
			threadId: null
		})
	},
	outbound: slackChannelOutbound
});
//#endregion
export { createSlackActions as a, resolveSlackChannelType as i, buildSlackThreadingToolContext as n, resolveSlackAutoThreadId as o, __resetSlackChannelTypeCacheForTest as r, slackPlugin as t };
