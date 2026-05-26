import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { f as resolveThreadSessionKeys } from "./session-key-DFEyR49L.js";
import { t as runTasksWithConcurrency } from "./run-with-concurrency-u5TU0MMx.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-CouSpJO4.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { n as readSessionUpdatedAt } from "./store-3qAZ3Zl6.js";
import { t as resolveConversationLabel } from "./conversation-label-BwWSua75.js";
import { a as enqueueSystemEvent } from "./system-events-D_-_Inav.js";
import { a as resolveInboundLastRouteSessionKey, i as resolveAgentRoute } from "./resolve-route-DQZZzDyD.js";
import { t as resolveAckReaction } from "./identity-CRZts9Qd.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-BeJyCrpU.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes } from "./mentions-C1aKJ5EP.js";
import { t as finalizeInboundContext } from "./inbound-context-DC32Bk5a.js";
import "./error-runtime-BnVeBNYa.js";
import "./runtime-env-AKjXcC53.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./routing-BfSZVtOk.js";
import { t as hasControlCommand } from "./command-detection-bZlW0Mh2.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope } from "./envelope-DNto3K3h.js";
import { i as shouldAckReaction } from "./ack-reactions-D6S-dTdd.js";
import { t as implicitMentionKindWhen } from "./mention-gating-Bq0XC9aB.js";
import { d as recordPendingHistoryEntryIfEnabled, o as buildPendingHistoryContextFromMap } from "./history-DVJTezhz.js";
import { n as resolveChannelSourceReplyDeliveryMode } from "./reply-pipeline-B0RIiqGl.js";
import { n as filterSupplementalContextItems, r as shouldIncludeSupplementalContext } from "./context-visibility-MVLx0ZIv.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist } from "./channel-access-compat-Dny0RAlV.js";
import "./reply-history-DFZwzL3w.js";
import { t as resolveChannelContextVisibilityMode } from "./context-visibility-CvSfDUOi.js";
import "./reply-dispatch-runtime-s-cxPvmJ.js";
import "./system-event-runtime-L5JTiCmm.js";
import { n as resolveConfiguredBindingRoute, r as resolveRuntimeConversationBindingRoute, t as ensureConfiguredBindingRouteReady } from "./binding-routing-LTxSqa_y.js";
import "./conversation-runtime-BzsYFdpF.js";
import "./security-runtime-JcBeOGgV.js";
import "./command-detection-BsGMXPHd.js";
import "./command-surface-plOjejO_.js";
import { n as logInboundDrop } from "./logging-BKsFuiAg.js";
import "./channel-feedback-B9Irbkxa.js";
import "./channel-inbound-DuNiLVQs.js";
import "./channel-message-CmG6T1ry.js";
import { l as resolveSlackReplyToMode } from "./accounts-Ba1LnRZV.js";
import { r as parseSlackTarget } from "./target-parsing-V_XPO9_R.js";
import { i as normalizeSlackAllowOwnerEntry, o as resolveSlackAllowListMatch, r as normalizeAllowListLower } from "./allow-list-NJrZzx1V.js";
import { i as hasSlackThreadParticipationWithPersistence, t as sendMessageSlack } from "./send-N1ZXm8DK.js";
import { l as reactSlackMessage } from "./actions-DM_Aqnbb.js";
import { c as resolveSlackThreadStarter, s as resolveSlackThreadHistory, u as formatSlackFileReference } from "./media-kHQwUTGX.js";
import { t as formatSlackError } from "./errors-C7qatgFo.js";
import { a as resolveSlackCommandIngress, d as resolveSlackChannelConfig, h as stripSlackMentionsForCommandDetection, l as normalizeSlackChannelType, n as authorizeSlackDirectMessage, o as resolveSlackEffectiveAllowFrom, r as authorizeSlackBotRoomMessage, t as resolveSlackRoomContextHints, u as resolveSlackChatType } from "./room-context-DrGzGSyg.js";
import "./send.runtime-CzUICsUl.js";
//#region extensions/slack/src/monitor/message-handler/prepare-content.ts
const SLACK_MENTION_RESOLUTION_CONCURRENCY = 4;
const SLACK_MENTION_RESOLUTION_MAX_LOOKUPS_PER_MESSAGE = 20;
const SLACK_USER_MENTION_RE$1 = /<@([A-Z0-9]+)(?:\|[^>]+)?>/gi;
let slackMediaModulePromise$1;
function loadSlackMediaModule$1() {
	slackMediaModulePromise$1 ??= import("./media-CeBJAx36.js");
	return slackMediaModulePromise$1;
}
function collectUniqueSlackMentionIds$1(texts) {
	const seen = /* @__PURE__ */ new Set();
	const mentionIds = [];
	for (const text of texts) {
		if (!text) continue;
		SLACK_USER_MENTION_RE$1.lastIndex = 0;
		for (const match of text.matchAll(SLACK_USER_MENTION_RE$1)) {
			const userId = match[1];
			if (!userId || seen.has(userId)) continue;
			seen.add(userId);
			mentionIds.push(userId);
		}
	}
	return mentionIds;
}
function renderSlackUserMentions(text, renderedMentions) {
	if (!text || renderedMentions.size === 0) return text;
	SLACK_USER_MENTION_RE$1.lastIndex = 0;
	return text.replace(SLACK_USER_MENTION_RE$1, (full, userId) => {
		return renderedMentions.get(userId) ?? full;
	});
}
function readString(value) {
	return typeof value === "string" ? value : void 0;
}
function readTextObject(value) {
	if (!value || typeof value !== "object") return;
	return normalizeOptionalString(readString(value.text));
}
function renderSlackRichTextLeaf(element) {
	switch (element.type) {
		case "text": return readString(element.text) ?? "";
		case "link": return readString(element.text) ?? readString(element.url) ?? "";
		case "user": {
			const userId = readString(element.user_id);
			return userId ? `<@${userId}>` : "";
		}
		case "channel": {
			const channelId = readString(element.channel_id);
			return channelId ? `<#${channelId}>` : "";
		}
		case "usergroup": {
			const usergroupId = readString(element.usergroup_id);
			return usergroupId ? `<!subteam^${usergroupId}>` : "";
		}
		case "broadcast": {
			const range = readString(element.range);
			return range ? `<!${range}>` : "";
		}
		case "emoji": {
			const name = readString(element.name);
			return name ? `:${name}:` : "";
		}
		default: return "";
	}
}
function renderSlackRichTextElements(elements) {
	if (!Array.isArray(elements)) return "";
	const parts = [];
	for (const rawElement of elements) {
		if (!rawElement || typeof rawElement !== "object") continue;
		const element = rawElement;
		switch (element.type) {
			case "rich_text_section":
			case "rich_text_preformatted":
			case "rich_text_quote":
				parts.push(renderSlackRichTextElements(element.elements));
				break;
			case "rich_text_list": {
				const listParts = [];
				if (Array.isArray(element.elements)) for (const child of element.elements) {
					if (!child || typeof child !== "object") continue;
					const rendered = renderSlackRichTextElements(child.elements);
					if (rendered) listParts.push(rendered);
				}
				const listText = listParts.join("\n");
				parts.push(listText);
				break;
			}
			default:
				parts.push(renderSlackRichTextLeaf(element));
				break;
		}
	}
	return parts.join("");
}
function readSlackBlockText(block) {
	if (!block || typeof block !== "object") return;
	const blockLike = block;
	switch (blockLike.type) {
		case "rich_text": return normalizeOptionalString(renderSlackRichTextElements(blockLike.elements));
		case "section": {
			const text = readTextObject(blockLike.text);
			if (text) return text;
			if (Array.isArray(blockLike.fields)) {
				const fields = [];
				for (const field of blockLike.fields) {
					const fieldText = readTextObject(field);
					if (fieldText) fields.push(fieldText);
				}
				return fields.length > 0 ? fields.join("\n") : void 0;
			}
			return;
		}
		case "header": return readTextObject(blockLike.text);
		case "context": {
			if (!Array.isArray(blockLike.elements)) return;
			const parts = [];
			for (const element of blockLike.elements) {
				const text = readTextObject(element);
				if (text) parts.push(text);
			}
			return parts.length > 0 ? parts.join(" ") : void 0;
		}
		case "image": return normalizeOptionalString(readString(blockLike.alt_text)) ?? readTextObject(blockLike.title);
		case "video": return readTextObject(blockLike.title) ?? normalizeOptionalString(readString(blockLike.alt_text));
		default: return;
	}
}
function resolveSlackBlocksText(blocks) {
	if (!blocks?.length) return;
	const parts = [];
	let hasRichText = false;
	for (const block of blocks) {
		if (block && typeof block === "object" && block.type === "rich_text") hasRichText = true;
		const text = readSlackBlockText(block);
		if (text) parts.push(text);
	}
	return parts.length > 0 ? {
		text: parts.join("\n"),
		hasRichText
	} : void 0;
}
function chooseSlackPrimaryText(params) {
	const { messageText, blocksText } = params;
	if (!blocksText) return messageText;
	if (!messageText) return blocksText.text;
	if (blocksText.hasRichText && blocksText.text.length > messageText.length) return blocksText.text;
	return blocksText.text.length > messageText.length && blocksText.text.startsWith(messageText) ? blocksText.text : messageText;
}
function filterInheritedParentFiles(params) {
	const { files, isThreadReply, threadStarter } = params;
	if (!isThreadReply || !files?.length) return files;
	if (!threadStarter?.files?.length) return files;
	const starterFileIds = new Set(threadStarter.files.map((file) => file.id));
	const filtered = files.filter((file) => !file.id || !starterFileIds.has(file.id));
	if (filtered.length < files.length) logVerbose(`slack: filtered ${files.length - filtered.length} inherited parent file(s) from thread reply`);
	return filtered.length > 0 ? filtered : void 0;
}
async function resolveSlackMessageContent(params) {
	const ownFiles = filterInheritedParentFiles({
		files: params.message.files,
		isThreadReply: params.isThreadReply,
		threadStarter: params.threadStarter
	});
	const mediaPromise = ownFiles && ownFiles.length > 0 ? loadSlackMediaModule$1().then(({ resolveSlackMedia }) => resolveSlackMedia({
		files: ownFiles,
		client: params.client,
		token: params.botToken,
		maxBytes: params.mediaMaxBytes
	})) : Promise.resolve(null);
	const attachmentContentPromise = params.message.attachments && params.message.attachments.length > 0 ? loadSlackMediaModule$1().then(({ resolveSlackAttachmentContent }) => resolveSlackAttachmentContent({
		attachments: params.message.attachments,
		client: params.client,
		token: params.botToken,
		maxBytes: params.mediaMaxBytes
	})) : Promise.resolve(null);
	const [media, attachmentContent] = await Promise.all([mediaPromise, attachmentContentPromise]);
	const mergedMedia = [...media ?? [], ...attachmentContent?.media ?? []];
	const effectiveDirectMedia = mergedMedia.length > 0 ? mergedMedia : null;
	const mediaPlaceholder = effectiveDirectMedia ? effectiveDirectMedia.map((item) => item.placeholder).join(" ") : void 0;
	const fallbackFiles = ownFiles ?? [];
	const fileOnlyFallback = !mediaPlaceholder && fallbackFiles.length > 0 ? fallbackFiles.slice(0, 8).map((file) => formatSlackFileReference(file)).join(", ") : void 0;
	const fileOnlyPlaceholder = fileOnlyFallback ? `[Slack file: ${fileOnlyFallback}]` : void 0;
	let botAttachmentText;
	if (params.isBotMessage && !attachmentContent?.text) {
		const botAttachmentTextParts = [];
		for (const attachment of params.message.attachments ?? []) {
			const text = normalizeOptionalString(attachment.text) ?? normalizeOptionalString(attachment.fallback);
			if (text) botAttachmentTextParts.push(text);
		}
		botAttachmentText = botAttachmentTextParts.length > 0 ? botAttachmentTextParts.join("\n") : void 0;
	}
	const blocksText = resolveSlackBlocksText(params.message.blocks);
	const textParts = [
		chooseSlackPrimaryText({
			messageText: normalizeOptionalString(params.message.text),
			blocksText
		}),
		attachmentContent?.text,
		botAttachmentText
	];
	const renderedMentions = /* @__PURE__ */ new Map();
	const resolveUserName = params.resolveUserName;
	if (resolveUserName) {
		const mentionIds = collectUniqueSlackMentionIds$1(textParts);
		const lookupIds = mentionIds.slice(0, SLACK_MENTION_RESOLUTION_MAX_LOOKUPS_PER_MESSAGE);
		const skippedLookups = mentionIds.length - lookupIds.length;
		if (skippedLookups > 0) logVerbose(`slack: skipping ${skippedLookups} mention lookup(s) beyond per-message cap (${SLACK_MENTION_RESOLUTION_MAX_LOOKUPS_PER_MESSAGE})`);
		const { results } = await runTasksWithConcurrency({
			tasks: lookupIds.map((userId) => async () => {
				const renderedName = normalizeOptionalString((await resolveUserName(userId))?.name);
				return {
					userId,
					rendered: renderedName ? `<@${userId}> (${renderedName})` : null
				};
			}),
			limit: SLACK_MENTION_RESOLUTION_CONCURRENCY
		});
		for (const result of results) {
			if (!result) continue;
			renderedMentions.set(result.userId, result.rendered);
		}
	}
	const rawBody = [
		renderSlackUserMentions(textParts[0], renderedMentions),
		renderSlackUserMentions(textParts[1], renderedMentions),
		renderSlackUserMentions(textParts[2], renderedMentions),
		mediaPlaceholder,
		fileOnlyPlaceholder
	].filter(Boolean).join("\n") || "";
	if (!rawBody) return null;
	return {
		rawBody,
		effectiveDirectMedia
	};
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare-dm-history.ts
function resolveSlackDmHistoryLimit(params) {
	const override = params.userId && params.account.config.dms?.[params.userId]?.historyLimit !== void 0 ? params.account.config.dms[params.userId]?.historyLimit : void 0;
	return Math.max(0, override ?? params.defaultLimit);
}
async function resolveSlackDmHistoryContext(params) {
	const maxMessages = Math.max(0, Math.floor(params.limit));
	if (maxMessages <= 0) return {
		body: void 0,
		inboundHistory: void 0
	};
	try {
		const messages = ((await params.ctx.app.client.conversations.history({
			token: params.ctx.botToken,
			channel: params.channelId,
			...params.currentMessageTs ? {
				latest: params.currentMessageTs,
				inclusive: true
			} : {},
			limit: maxMessages + 1
		})).messages ?? []).filter((message) => {
			if (params.currentMessageTs && message.ts === params.currentMessageTs) return false;
			return Boolean(normalizeOptionalString(message.text));
		}).slice(0, maxMessages).toReversed();
		if (messages.length === 0) return {
			body: void 0,
			inboundHistory: void 0
		};
		const userNames = /* @__PURE__ */ new Map();
		const resolveUserLabel = async (userId) => {
			const cached = userNames.get(userId);
			if (cached) return cached;
			const label = normalizeOptionalString((await params.ctx.resolveUserName(userId)).name) ?? userId;
			userNames.set(userId, label);
			return label;
		};
		const entries = [];
		const formatted = [];
		for (const message of messages) {
			const body = normalizeOptionalString(message.text);
			if (!body) continue;
			const isCurrentBot = params.ctx.botUserId && message.user === params.ctx.botUserId || params.ctx.botId && message.bot_id === params.ctx.botId;
			const role = isCurrentBot || message.bot_id ? "assistant" : "user";
			const sender = `${isCurrentBot ? "Assistant" : message.user ? await resolveUserLabel(message.user) : normalizeOptionalString(message.username) ?? (message.bot_id ? "Bot" : "Unknown")} (${role})`;
			const timestamp = message.ts ? Math.round(Number(message.ts) * 1e3) : void 0;
			entries.push({
				sender,
				body,
				timestamp
			});
			formatted.push(formatInboundEnvelope({
				channel: "Slack",
				from: sender,
				timestamp,
				body: `${body}\n[slack message id: ${message.ts ?? "unknown"} channel: ${params.channelId}]`,
				chatType: "direct",
				envelope: params.envelopeOptions
			}));
		}
		return {
			body: formatted.length > 0 ? formatted.join("\n\n") : void 0,
			inboundHistory: entries.length > 0 ? entries : void 0
		};
	} catch (err) {
		logVerbose(`slack: failed to fetch DM history for channel ${params.channelId}: ${formatErrorMessage(err)}`);
		return {
			body: void 0,
			inboundHistory: void 0
		};
	}
}
//#endregion
//#region extensions/slack/src/threading.ts
function resolveSlackThreadContext(params) {
	const incomingThreadTs = params.message.thread_ts;
	const eventTs = params.message.event_ts;
	const messageTs = params.message.ts ?? eventTs;
	const isThreadReply = typeof incomingThreadTs === "string" && incomingThreadTs.length > 0 && (incomingThreadTs !== messageTs || Boolean(params.message.parent_user_id));
	return {
		incomingThreadTs,
		messageTs,
		isThreadReply,
		replyToId: incomingThreadTs ?? messageTs,
		messageThreadId: isThreadReply ? incomingThreadTs : params.replyToMode === "all" ? messageTs : void 0
	};
}
/**
* Resolves Slack thread targeting for replies and status indicators.
*
* @returns replyThreadTs - Thread timestamp for reply messages
* @returns statusThreadTs - Thread timestamp for status indicators (typing, etc.)
* @returns isThreadReply - true if this is a genuine user reply in a thread,
*                          false if thread_ts comes from a bot status message (e.g. typing indicator)
*/
function resolveSlackThreadTargets(params) {
	const { incomingThreadTs, messageTs, isThreadReply } = resolveSlackThreadContext(params);
	const replyThreadTs = isThreadReply ? incomingThreadTs : params.replyToMode === "all" ? messageTs : void 0;
	return {
		replyThreadTs,
		statusThreadTs: replyThreadTs,
		isThreadReply
	};
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare-routing.ts
const slackRouteBindingConfigCache = /* @__PURE__ */ new WeakMap();
function slackTargetDefaultKindForPeer(kind) {
	return kind === "direct" ? "user" : "channel";
}
function slackTargetKindMatchesPeer(peerKind, targetKind) {
	if (targetKind === "user") return peerKind === "direct";
	return peerKind === "channel" || peerKind === "group";
}
function normalizeSlackRouteBindingPeer(peer) {
	const rawId = peer.id.trim();
	if (!rawId || rawId === "*") return peer;
	const target = (() => {
		try {
			return parseSlackTarget(rawId, { defaultKind: slackTargetDefaultKindForPeer(peer.kind) });
		} catch {
			return;
		}
	})();
	if (!target || !slackTargetKindMatchesPeer(peer.kind, target.kind) || target.id === peer.id) return peer;
	return {
		...peer,
		id: target.id
	};
}
function normalizeSlackRouteBindingConfig(cfg) {
	const bindings = cfg.bindings;
	const cached = slackRouteBindingConfigCache.get(cfg);
	if (cached && cached.bindingsRef === bindings) return cached.normalizedCfg;
	if (!Array.isArray(bindings)) return cfg;
	let changed = false;
	const normalizedBindings = bindings.map((binding) => {
		if (binding.type === "acp" || binding.match.channel.trim().toLowerCase() !== "slack") return binding;
		const peer = binding.match.peer;
		if (!peer) return binding;
		const normalizedPeer = normalizeSlackRouteBindingPeer(peer);
		if (normalizedPeer === peer) return binding;
		changed = true;
		return {
			...binding,
			match: {
				...binding.match,
				peer: normalizedPeer
			}
		};
	});
	const normalizedCfg = changed ? {
		...cfg,
		bindings: normalizedBindings
	} : cfg;
	slackRouteBindingConfigCache.set(cfg, {
		bindingsRef: bindings,
		normalizedCfg
	});
	return normalizedCfg;
}
function resolveSlackBaseConversationId(params) {
	return params.isDirectMessage ? `user:${params.message.user ?? "unknown"}` : params.message.channel;
}
function resolveSlackInitialAgentRoute(params) {
	return resolveAgentRoute({
		cfg: normalizeSlackRouteBindingConfig(params.ctx.cfg),
		channel: "slack",
		accountId: params.account.accountId,
		teamId: params.ctx.teamId || void 0,
		peer: {
			kind: params.isDirectMessage ? "direct" : params.isRoom ? "channel" : "group",
			id: params.isDirectMessage ? params.message.user ?? "unknown" : params.message.channel
		}
	});
}
function resolveSlackRoutingContext(params) {
	const { ctx, account, message, isDirectMessage, isGroupDm, isRoom, isRoomish, seedTopLevelRoomThread } = params;
	let route = resolveSlackInitialAgentRoute({
		ctx,
		account,
		message,
		isDirectMessage,
		isRoom
	});
	const chatType = isDirectMessage ? "direct" : isGroupDm ? "group" : "channel";
	const replyToMode = resolveSlackReplyToMode(account, chatType);
	const threadContext = resolveSlackThreadContext({
		message,
		replyToMode
	});
	const threadTs = threadContext.incomingThreadTs;
	const isThreadReply = threadContext.isThreadReply;
	const autoThreadId = !isThreadReply && replyToMode === "all" && threadContext.messageTs ? threadContext.messageTs : void 0;
	const seedCandidateThreadId = threadContext.incomingThreadTs ?? threadContext.messageTs;
	const routedThreadId = (isDirectMessage ? isThreadReply ? threadTs : void 0 : isRoomish ? isThreadReply && threadTs ? threadTs : void 0 : isThreadReply ? threadTs : autoThreadId) ?? (isRoomish ? !isThreadReply && isRoom && seedTopLevelRoomThread && replyToMode !== "off" && seedCandidateThreadId ? seedCandidateThreadId : void 0 : void 0);
	const baseConversationId = resolveSlackBaseConversationId({
		message,
		isDirectMessage
	});
	const boundThreadRoute = routedThreadId ? resolveRuntimeConversationBindingRoute({
		route,
		conversation: {
			channel: "slack",
			accountId: account.accountId,
			conversationId: routedThreadId,
			parentConversationId: baseConversationId
		}
	}) : null;
	const runtimeRoute = boundThreadRoute?.boundSessionKey || boundThreadRoute?.bindingRecord ? boundThreadRoute : resolveRuntimeConversationBindingRoute({
		route,
		conversation: {
			channel: "slack",
			accountId: account.accountId,
			conversationId: baseConversationId
		}
	});
	let configuredBinding = null;
	let configuredBindingSessionKey = "";
	if (runtimeRoute.boundSessionKey || runtimeRoute.bindingRecord) route = runtimeRoute.route;
	else {
		const configuredRoute = resolveConfiguredBindingRoute({
			cfg: ctx.cfg,
			route,
			conversation: {
				channel: "slack",
				accountId: account.accountId,
				conversationId: baseConversationId
			}
		});
		configuredBinding = configuredRoute.bindingResolution;
		configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
		route = configuredRoute.route;
	}
	const threadKeys = runtimeRoute.boundSessionKey || configuredBindingSessionKey ? {
		sessionKey: route.sessionKey,
		parentSessionKey: void 0
	} : resolveThreadSessionKeys({
		baseSessionKey: route.sessionKey,
		threadId: routedThreadId,
		parentSessionKey: routedThreadId && ctx.threadInheritParent ? route.sessionKey : void 0
	});
	const sessionKey = threadKeys.sessionKey;
	const historyKey = isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel;
	return {
		route,
		runtimeBinding: runtimeRoute.bindingRecord,
		runtimeBoundSessionKey: runtimeRoute.boundSessionKey,
		configuredBinding,
		configuredBindingSessionKey,
		chatType,
		replyToMode,
		threadContext,
		threadTs,
		isThreadReply,
		threadKeys,
		sessionKey,
		historyKey
	};
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare-thread-context-root.ts
function isSlackThreadAuthorCurrentBot(params) {
	const { identity, author } = params;
	if (identity.botUserId && author.userId && author.userId === identity.botUserId) return true;
	if (identity.botId && author.botId && author.botId === identity.botId) return true;
	return false;
}
function resolveSlackThreadHistoryFilterPolicy(params) {
	if (!params.includeBotStarterAsRootContext || !params.starterTs) return {};
	return { retainCurrentBotRootTs: params.starterTs };
}
function applySlackThreadHistoryFilterPolicy(params) {
	const kept = [];
	let omittedCurrentBot = 0;
	for (const entry of params.history) {
		if (!isSlackThreadAuthorCurrentBot({
			identity: params.identity,
			author: entry
		})) {
			kept.push(entry);
			continue;
		}
		if (params.policy.retainCurrentBotRootTs && entry.ts === params.policy.retainCurrentBotRootTs) kept.push(entry);
		else omittedCurrentBot += 1;
	}
	return {
		kept,
		omittedCurrentBot
	};
}
function shouldIncludeBotThreadStarterContext(params) {
	if (!params.hasStarterText) return false;
	return params.starterIsCurrentBot && params.isNewThreadSession;
}
function ensureSlackThreadHistoryHasBotRoot(params) {
	if (!params.includeBotStarterAsRootContext || !params.threadStarter?.text) return params.history;
	if (params.history.some((entry) => entry.ts === params.threadStarter?.ts)) return params.history;
	return [params.threadStarter, ...params.history];
}
function formatSlackBotStarterThreadLabel(params) {
	const base = `Slack thread ${params.roomLabel}`;
	if (!params.starterText) return base;
	const snippet = params.starterText.replace(/\s+/g, " ").slice(0, 80).trim();
	if (!snippet) return base;
	return `${base} (assistant root): ${snippet}`;
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare-thread-context.ts
let slackMediaModulePromise;
function loadSlackMediaModule() {
	slackMediaModulePromise ??= import("./media-CeBJAx36.js");
	return slackMediaModulePromise;
}
const SLACK_THREAD_CONTEXT_USER_LOOKUP_CONCURRENCY = 4;
function isSlackThreadContextSenderAllowed(params) {
	if (params.allowFromLower.length === 0 || params.botId) return true;
	if (!params.userId) return false;
	return resolveSlackAllowListMatch({
		allowList: params.allowFromLower,
		id: params.userId,
		name: params.userName,
		allowNameMatching: params.allowNameMatching
	}).allowed;
}
async function resolveSlackThreadUserMap(params) {
	const uniqueUserIds = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of params.messages) {
		if (!item.userId || seen.has(item.userId)) continue;
		seen.add(item.userId);
		uniqueUserIds.push(item.userId);
	}
	const userMap = /* @__PURE__ */ new Map();
	if (uniqueUserIds.length === 0) return userMap;
	const { results } = await runTasksWithConcurrency({
		tasks: uniqueUserIds.map((id) => async () => {
			const user = await params.ctx.resolveUserName(id);
			return user ? {
				id,
				user
			} : null;
		}),
		limit: SLACK_THREAD_CONTEXT_USER_LOOKUP_CONCURRENCY
	});
	for (const result of results) if (result) userMap.set(result.id, result.user);
	return userMap;
}
async function resolveSlackThreadContextData(params) {
	const botIdentity = {
		botUserId: params.ctx.botUserId,
		botId: params.ctx.botId
	};
	const isCurrentBotAuthor = (author) => isSlackThreadAuthorCurrentBot({
		identity: botIdentity,
		author
	});
	let threadStarterBody;
	let threadHistoryBody;
	let threadSessionPreviousTimestamp;
	let threadLabel;
	let threadStarterMedia = null;
	if (!params.isThreadReply || !params.threadTs) return {
		threadStarterBody,
		threadHistoryBody,
		threadSessionPreviousTimestamp,
		threadLabel,
		threadStarterMedia
	};
	const starter = params.threadStarter;
	const starterSenderName = params.allowNameMatching && params.allowFromLower.length > 0 && starter?.userId ? (await params.ctx.resolveUserName(starter.userId))?.name : void 0;
	const starterIsCurrentBot = Boolean(starter && isCurrentBotAuthor({
		userId: starter.userId,
		botId: starter.botId
	}));
	const starterAllowed = !starter || !starterIsCurrentBot && isSlackThreadContextSenderAllowed({
		allowFromLower: params.allowFromLower,
		allowNameMatching: params.allowNameMatching,
		userId: starter.userId,
		userName: starterSenderName,
		botId: starter.botId
	});
	const includeStarterContext = !starter || !starterIsCurrentBot && shouldIncludeSupplementalContext({
		mode: params.contextVisibilityMode,
		kind: "thread",
		senderAllowed: starterAllowed
	});
	if (starter?.text && includeStarterContext) {
		threadStarterBody = starter.text;
		const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
		threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
		if (!params.effectiveDirectMedia && starter.files && starter.files.length > 0) {
			const { resolveSlackMedia } = await loadSlackMediaModule();
			threadStarterMedia = await resolveSlackMedia({
				files: starter.files,
				client: params.ctx.app.client,
				token: params.ctx.botToken,
				maxBytes: params.ctx.mediaMaxBytes
			});
			if (threadStarterMedia) logVerbose(`slack: hydrated thread starter file ${threadStarterMedia.map((item) => item.placeholder).join(", ")} from root message`);
		}
	} else threadLabel = `Slack thread ${params.roomLabel}`;
	threadSessionPreviousTimestamp = readSessionUpdatedAt({
		storePath: params.storePath,
		sessionKey: params.sessionKey
	});
	const includeBotStarterAsRootContext = shouldIncludeBotThreadStarterContext({
		starterIsCurrentBot,
		isNewThreadSession: !threadSessionPreviousTimestamp,
		hasStarterText: Boolean(starter?.text)
	});
	if (starter?.text && starterIsCurrentBot && !includeBotStarterAsRootContext) logVerbose("slack: omitted current-bot thread starter from context");
	else if (starter?.text && !includeStarterContext && !starterIsCurrentBot) logVerbose(`slack: omitted thread starter from context (mode=${params.contextVisibilityMode}, sender_allowed=${starterAllowed ? "yes" : "no"})`);
	else if (includeBotStarterAsRootContext) {
		threadLabel = formatSlackBotStarterThreadLabel({
			roomLabel: params.roomLabel,
			starterText: starter?.text
		});
		logVerbose("slack: retained current-bot thread starter as assistant root context");
	}
	const threadInitialHistoryLimit = params.account.config?.thread?.initialHistoryLimit ?? 20;
	if (threadInitialHistoryLimit > 0 && !threadSessionPreviousTimestamp) {
		const currentBotRootTs = starter?.ts ?? params.threadTs;
		const threadHistoryWithBotRoot = ensureSlackThreadHistoryHasBotRoot({
			history: await resolveSlackThreadHistory({
				channelId: params.message.channel,
				threadTs: params.threadTs,
				client: params.ctx.app.client,
				currentMessageTs: params.message.ts,
				limit: threadInitialHistoryLimit
			}),
			includeBotStarterAsRootContext,
			threadStarter: starter ? {
				...starter,
				ts: currentBotRootTs
			} : null
		});
		if (threadHistoryWithBotRoot.length > 0) {
			const { kept: threadHistoryWithoutCurrentBot, omittedCurrentBot: omittedCurrentBotHistoryCount } = applySlackThreadHistoryFilterPolicy({
				history: threadHistoryWithBotRoot,
				policy: resolveSlackThreadHistoryFilterPolicy({
					includeBotStarterAsRootContext,
					starterTs: currentBotRootTs
				}),
				identity: botIdentity
			});
			const userMapForFilter = params.contextVisibilityMode !== "all" && params.allowNameMatching && params.allowFromLower.length > 0 ? await resolveSlackThreadUserMap({
				ctx: params.ctx,
				messages: threadHistoryWithoutCurrentBot
			}) : /* @__PURE__ */ new Map();
			const { items: filteredThreadHistory, omitted: omittedHistoryCount } = params.contextVisibilityMode === "all" ? {
				items: threadHistoryWithoutCurrentBot,
				omitted: 0
			} : filterSupplementalContextItems({
				items: threadHistoryWithoutCurrentBot,
				mode: params.contextVisibilityMode,
				kind: "thread",
				isSenderAllowed: (historyMsg) => {
					if (isCurrentBotAuthor({
						userId: historyMsg.userId,
						botId: historyMsg.botId
					})) return true;
					const msgUser = historyMsg.userId ? userMapForFilter.get(historyMsg.userId) : null;
					return isSlackThreadContextSenderAllowed({
						allowFromLower: params.allowFromLower,
						allowNameMatching: params.allowNameMatching,
						userId: historyMsg.userId,
						userName: msgUser?.name,
						botId: historyMsg.botId
					});
				}
			});
			const userMap = await resolveSlackThreadUserMap({
				ctx: params.ctx,
				messages: filteredThreadHistory
			});
			if (omittedHistoryCount > 0 || omittedCurrentBotHistoryCount > 0) logVerbose(`slack: omitted ${omittedHistoryCount + omittedCurrentBotHistoryCount} thread message(s) from context (mode=${params.contextVisibilityMode})`);
			const historyParts = [];
			for (const historyMsg of filteredThreadHistory) {
				const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
				const isOtherBot = Boolean(historyMsg.botId) && historyMsg.botId !== params.ctx.botId;
				const isCurrentBot = isCurrentBotAuthor({
					userId: historyMsg.userId,
					botId: historyMsg.botId
				});
				const role = isCurrentBot || isOtherBot || Boolean(historyMsg.botId) ? "assistant" : "user";
				const msgSenderName = isCurrentBot ? "Bot (this assistant)" : msgUser?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown");
				const msgWithId = `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
				historyParts.push(formatInboundEnvelope({
					channel: "Slack",
					from: `${msgSenderName} (${role})`,
					timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1e3) : void 0,
					body: msgWithId,
					chatType: "channel",
					envelope: params.envelopeOptions
				}));
			}
			if (historyParts.length > 0) {
				threadHistoryBody = historyParts.join("\n\n");
				logVerbose(`slack: populated thread history with ${filteredThreadHistory.length} messages for new session`);
			}
		}
	}
	return {
		threadStarterBody,
		threadHistoryBody,
		threadSessionPreviousTimestamp,
		threadLabel,
		threadStarterMedia
	};
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/subteam-mentions.ts
const SUBTEAM_MENTION_RE = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/gi;
const SUBTEAM_MEMBER_CACHE_TTL_MS = 300 * 1e3;
let subteamMemberCache = /* @__PURE__ */ new WeakMap();
function normalizeSlackId(value) {
	return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : void 0;
}
function extractSlackSubteamMentionIds(text) {
	if (!text) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const match of text.matchAll(SUBTEAM_MENTION_RE)) {
		const id = normalizeSlackId(match[1]);
		if (id) ids.add(id);
	}
	return [...ids];
}
async function readSlackSubteamUsers(params) {
	let bySubteam = subteamMemberCache.get(params.client);
	if (!bySubteam) {
		bySubteam = /* @__PURE__ */ new Map();
		subteamMemberCache.set(params.client, bySubteam);
	}
	const cacheKey = `${normalizeSlackId(params.teamId) ?? ""}:${params.subteamId}`;
	const cached = bySubteam.get(cacheKey);
	if (cached && cached.expiresAt > params.now) return cached.users;
	try {
		const response = await params.client.usergroups.users.list({
			usergroup: params.subteamId,
			...params.teamId ? { team_id: params.teamId } : {}
		});
		if (!response.ok) {
			params.log?.(`slack: failed to resolve user-group mention ${params.subteamId}: ${response.error ?? "unknown_error"}`);
			return /* @__PURE__ */ new Set();
		}
		const users = new Set((response.users ?? []).map((userId) => normalizeSlackId(userId)).filter(Boolean));
		bySubteam.set(cacheKey, {
			expiresAt: params.now + SUBTEAM_MEMBER_CACHE_TTL_MS,
			users
		});
		return users;
	} catch (err) {
		params.log?.(`slack: failed to resolve user-group mention ${params.subteamId}: ${formatErrorMessage(err)}`);
		return /* @__PURE__ */ new Set();
	}
}
async function isSlackSubteamMentionForBot(params) {
	const botUserId = normalizeSlackId(params.botUserId);
	if (!botUserId) return false;
	const subteamIds = extractSlackSubteamMentionIds(params.text);
	if (subteamIds.length === 0) return false;
	const now = params.now ?? Date.now();
	for (const subteamId of subteamIds) if ((await readSlackSubteamUsers({
		client: params.client,
		subteamId,
		teamId: normalizeOptionalString(params.teamId),
		now,
		log: params.log
	})).has(botUserId)) return true;
	return false;
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare.ts
const mentionRegexCache = /* @__PURE__ */ new WeakMap();
const SLACK_ANY_MENTION_RE = /<@[^>]+>|<!subteam\^[^>]+>/;
const SLACK_USER_MENTION_RE = /<@([^>|]+)(?:\|[^>]+)?>/g;
const SLACK_SUBTEAM_MENTION_RE = /<!subteam\^([^>|]+)(?:\|[^>]+)?>/g;
const SLACK_SUBTEAM_MENTION_MARKER = "<!subteam^";
function resolveCachedMentionRegexes(ctx, agentId) {
	const key = normalizeOptionalString(agentId) ?? "__default__";
	let byAgent = mentionRegexCache.get(ctx);
	if (!byAgent) {
		byAgent = /* @__PURE__ */ new Map();
		mentionRegexCache.set(ctx, byAgent);
	}
	const cached = byAgent.get(key);
	if (cached) return cached;
	const built = buildMentionRegexes(ctx.cfg, agentId);
	byAgent.set(key, built);
	return built;
}
function collectUniqueSlackMentionIds(text, regex) {
	const ids = [];
	regex.lastIndex = 0;
	for (const match of text.matchAll(regex)) {
		const id = normalizeOptionalString(match[1]);
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}
function collectSlackMentionMetadata(text) {
	return {
		mentionedUserIds: collectUniqueSlackMentionIds(text, SLACK_USER_MENTION_RE),
		mentionedSubteamIds: collectUniqueSlackMentionIds(text, SLACK_SUBTEAM_MENTION_RE),
		hasAnyMention: SLACK_ANY_MENTION_RE.test(text),
		hasSubteamMention: text.includes(SLACK_SUBTEAM_MENTION_MARKER)
	};
}
async function resolveSlackExplicitMentionState(params) {
	const explicitlyMentionedBotUser = Boolean(params.ctx.botUserId && params.mentionedUserIds.includes(params.ctx.botUserId));
	const explicitlyMentionedBotSubteam = Boolean(params.ctx.botUserId && params.hasSubteamMention) && await isSlackSubteamMentionForBot({
		client: params.ctx.app.client,
		text: params.messageText,
		botUserId: params.ctx.botUserId,
		teamId: params.ctx.teamId,
		log: logVerbose
	});
	return {
		explicitlyMentionedBotUser,
		explicitlyMentionedBotSubteam,
		explicitlyMentioned: explicitlyMentionedBotUser || explicitlyMentionedBotSubteam || params.source === "app_mention"
	};
}
function resolveSlackMentionSource(params) {
	if (params.explicitBotMention) return "explicit_bot";
	if (params.explicitSubteamMention) return "subteam";
	if (params.shouldBypassMention) return "command_bypass";
	if (params.wasMentioned) return "mention_pattern";
	if (params.matchedImplicitMentionKinds.length > 0) return "implicit_thread";
	return "none";
}
function buildSlackMentionContextPayload(params) {
	if (!params.isRoomish) return {};
	return {
		WasMentioned: params.effectiveWasMentioned,
		ExplicitlyMentionedBot: params.explicitlyMentioned,
		MentionedUserIds: params.mentionedUserIds.length > 0 ? [...params.mentionedUserIds] : void 0,
		MentionedSubteamIds: params.mentionedSubteamIds.length > 0 ? [...params.mentionedSubteamIds] : void 0,
		ImplicitMentionKinds: params.matchedImplicitMentionKinds.length > 0 ? [...params.matchedImplicitMentionKinds] : void 0,
		MentionSource: params.mentionSource
	};
}
async function resolveSlackConversationContext(params) {
	const { ctx, account, message } = params;
	const cfg = ctx.cfg;
	let channelInfo = {};
	let resolvedChannelType = normalizeSlackChannelType(message.channel_type, message.channel);
	if (resolvedChannelType !== "im" && (!message.channel_type || message.channel_type !== "im")) {
		channelInfo = await ctx.resolveChannelName(message.channel);
		resolvedChannelType = normalizeSlackChannelType(message.channel_type ?? channelInfo.type, message.channel);
	}
	const channelName = channelInfo?.name;
	const isDirectMessage = resolvedChannelType === "im";
	const isGroupDm = resolvedChannelType === "mpim";
	const isRoom = resolvedChannelType === "channel" || resolvedChannelType === "group";
	const isRoomish = isRoom || isGroupDm;
	const channelConfig = isRoom ? resolveSlackChannelConfig({
		channelId: message.channel,
		channelName,
		channels: ctx.channelsConfig,
		channelKeys: ctx.channelsConfigKeys,
		defaultRequireMention: ctx.defaultRequireMention,
		allowNameMatching: ctx.allowNameMatching
	}) : null;
	const allowBotsSetting = channelConfig?.allowBots ?? account.config?.allowBots ?? cfg.channels?.slack?.allowBots ?? false;
	return {
		channelInfo,
		channelName,
		resolvedChannelType,
		isDirectMessage,
		isGroupDm,
		isRoom,
		isRoomish,
		channelConfig,
		allowBotsMode: allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting ? "all" : "off",
		isBotMessage: Boolean(message.bot_id)
	};
}
async function authorizeSlackInboundMessage(params) {
	const { ctx, account, message, conversation } = params;
	const { isDirectMessage, channelName, resolvedChannelType, isBotMessage, allowBotsMode } = conversation;
	if (isBotMessage) {
		if (message.user && ctx.botUserId && message.user === ctx.botUserId) return null;
		if (allowBotsMode === "off") {
			logVerbose(`slack: drop bot message ${message.bot_id ?? "unknown"} (allowBots=false)`);
			return null;
		}
	}
	if (isDirectMessage && !message.user) {
		logVerbose("slack: drop dm message (missing user id)");
		return null;
	}
	const senderId = message.user ?? (isBotMessage ? message.bot_id : void 0);
	if (!senderId) {
		logVerbose("slack: drop message (missing sender id)");
		return null;
	}
	if (!ctx.isChannelAllowed({
		channelId: message.channel,
		channelName,
		channelType: resolvedChannelType
	})) {
		logVerbose("slack: drop message (channel not allowed)");
		return null;
	}
	const allowFromLower = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: isDirectMessage });
	if (isDirectMessage) {
		const directUserId = message.user;
		if (!directUserId) {
			logVerbose("slack: drop dm message (missing user id)");
			return null;
		}
		if (!await authorizeSlackDirectMessage({
			ctx,
			accountId: account.accountId,
			senderId: directUserId,
			allowFromLower,
			resolveSenderName: ctx.resolveUserName,
			sendPairingReply: async (text) => {
				await sendMessageSlack(message.channel, text, {
					cfg: ctx.cfg,
					token: ctx.botToken,
					client: ctx.app.client,
					accountId: account.accountId
				});
			},
			onDisabled: () => {
				logVerbose("slack: drop dm (dms disabled)");
			},
			onUnauthorized: ({ allowMatchMeta }) => {
				logVerbose(`Blocked unauthorized slack sender ${message.user} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`);
			},
			log: logVerbose
		})) return null;
	}
	return {
		senderId,
		allowFromLower
	};
}
async function prepareSlackMessage(params) {
	const { ctx, account, message, opts } = params;
	const cfg = ctx.cfg;
	const conversation = await resolveSlackConversationContext({
		ctx,
		account,
		message
	});
	const { channelInfo, channelName, isDirectMessage, isGroupDm, isRoom, isRoomish, channelConfig, allowBotsMode, isBotMessage } = conversation;
	const authorization = await authorizeSlackInboundMessage({
		ctx,
		account,
		message,
		conversation
	});
	if (!authorization) return null;
	const { senderId, allowFromLower } = authorization;
	const messageText = message.text ?? "";
	const mentionMetadata = collectSlackMentionMetadata(messageText);
	const { mentionedUserIds, mentionedSubteamIds, hasAnyMention } = mentionMetadata;
	const { explicitlyMentionedBotUser, explicitlyMentionedBotSubteam, explicitlyMentioned } = await resolveSlackExplicitMentionState({
		ctx,
		messageText,
		mentionedUserIds,
		hasSubteamMention: mentionMetadata.hasSubteamMention,
		source: opts.source
	});
	const channelRequireMention = channelConfig?.requireMention ?? ctx.defaultRequireMention ?? true;
	const willImplicitlyThreadReply = isRoom && !channelRequireMention && resolveSlackReplyToMode(account, isDirectMessage ? "direct" : isGroupDm ? "group" : "channel") !== "off";
	const seedTopLevelRoomThreadBySource = opts.source === "app_mention" || opts.wasMentioned === true || explicitlyMentioned || willImplicitlyThreadReply;
	let routing = resolveSlackRoutingContext({
		ctx,
		account,
		message,
		isDirectMessage,
		isGroupDm,
		isRoom,
		isRoomish,
		seedTopLevelRoomThread: seedTopLevelRoomThreadBySource
	});
	const resolveWasMentioned = (mentionRegexes) => opts.wasMentioned ?? (!isDirectMessage && matchesMentionWithExplicit({
		text: messageText,
		mentionRegexes,
		explicit: {
			hasAnyMention,
			isExplicitlyMentioned: explicitlyMentioned,
			canResolveExplicit: Boolean(ctx.botUserId)
		}
	}));
	let mentionRegexes = resolveCachedMentionRegexes(ctx, routing.route.agentId);
	let wasMentioned = resolveWasMentioned(mentionRegexes);
	const hasBoundSession = Boolean(routing.runtimeBoundSessionKey || routing.configuredBindingSessionKey);
	if (!seedTopLevelRoomThreadBySource && wasMentioned && isRoom && !routing.isThreadReply && !hasBoundSession) {
		routing = resolveSlackRoutingContext({
			ctx,
			account,
			message,
			isDirectMessage,
			isGroupDm,
			isRoom,
			isRoomish,
			seedTopLevelRoomThread: true
		});
		mentionRegexes = resolveCachedMentionRegexes(ctx, routing.route.agentId);
		wasMentioned = resolveWasMentioned(mentionRegexes);
	}
	const { route, runtimeBinding, configuredBinding, configuredBindingSessionKey, replyToMode, threadContext, threadTs, isThreadReply, threadKeys, sessionKey, historyKey } = routing;
	if (runtimeBinding && shouldLogVerbose()) logVerbose(`slack: routed via bound conversation ${runtimeBinding.conversation.conversationId} -> ${runtimeBinding.targetSessionKey}`);
	if (configuredBinding) {
		const ensured = await ensureConfiguredBindingRouteReady({
			cfg,
			bindingResolution: configuredBinding
		});
		if (ensured.ok) {
			if (shouldLogVerbose()) logVerbose(`slack: using configured ACP binding for ${configuredBinding.record.conversation.conversationId} -> ${configuredBindingSessionKey}`);
		} else {
			if (shouldLogVerbose()) logVerbose(`slack: configured ACP binding unavailable for ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`);
			logInboundDrop({
				log: logVerbose,
				channel: "slack",
				reason: "configured ACP binding unavailable",
				target: configuredBinding.record.conversation.conversationId
			});
			return null;
		}
	}
	let implicitMentionKinds = [];
	if (!isDirectMessage && ctx.botUserId && message.thread_ts && !ctx.threadRequireExplicitMention && !wasMentioned) {
		const replyToBotKinds = implicitMentionKindWhen("reply_to_bot", message.parent_user_id === ctx.botUserId);
		implicitMentionKinds = replyToBotKinds.length > 0 ? replyToBotKinds : implicitMentionKindWhen("bot_thread_participant", await hasSlackThreadParticipationWithPersistence({
			accountId: account.accountId,
			channelId: message.channel,
			threadTs: message.thread_ts
		}));
	}
	let resolvedSenderName = normalizeOptionalString(message.username);
	const resolveSenderName = async () => {
		if (resolvedSenderName) return resolvedSenderName;
		if (message.user) {
			const normalized = normalizeOptionalString((await ctx.resolveUserName(message.user))?.name);
			if (normalized) {
				resolvedSenderName = normalized;
				return resolvedSenderName;
			}
		}
		resolvedSenderName = message.user ?? message.bot_id ?? "unknown";
		return resolvedSenderName;
	};
	const senderNameForAuth = ctx.allowNameMatching ? await resolveSenderName() : void 0;
	const allowTextCommands = shouldHandleTextCommands({
		cfg,
		surface: "slack"
	});
	const shouldRequireMention = isRoom ? channelConfig?.requireMention ?? ctx.defaultRequireMention : false;
	if (message._ambiguousThreadReply) {
		ctx.logger.info({
			channel: message.channel,
			ts: message.ts,
			parentUserId: message.parent_user_id
		}, "skipping ambiguous slack thread reply");
		return null;
	}
	const canDetectMention = Boolean(ctx.botUserId) || mentionRegexes.length > 0;
	const textForCommandDetection = stripSlackMentionsForCommandDetection(message.text ?? "");
	const hasControlCommandInMessage = hasControlCommand(textForCommandDetection, cfg);
	const channelUsersAllowlistConfigured = isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
	const messageIngress = await resolveSlackCommandIngress({
		ctx,
		senderId,
		senderName: senderNameForAuth,
		channelType: conversation.resolvedChannelType ?? "channel",
		channelId: message.channel,
		ownerAllowFromLower: allowFromLower,
		channelUsers: isRoom ? channelConfig?.users : void 0,
		allowTextCommands,
		hasControlCommand: hasControlCommandInMessage,
		mentionFacts: {
			canDetectMention,
			wasMentioned,
			hasAnyMention,
			implicitMentionKinds
		},
		activation: {
			requireMention: shouldRequireMention,
			allowTextCommands,
			...ctx.threadRequireExplicitMention ? { allowedImplicitMentionKinds: [] } : {}
		}
	});
	const effectiveWasMentioned = messageIngress.activationAccess.effectiveWasMentioned ?? false;
	const shouldBypassMention = messageIngress.activationAccess.shouldBypassMention ?? false;
	const matchedImplicitMentionKinds = implicitMentionKinds;
	const mentionSource = resolveSlackMentionSource({
		explicitBotMention: explicitlyMentionedBotUser || opts.source === "app_mention",
		explicitSubteamMention: explicitlyMentionedBotSubteam,
		matchedImplicitMentionKinds,
		shouldBypassMention,
		wasMentioned
	});
	const senderGate = messageIngress.senderAccess.gate;
	if (isRoom && senderGate?.allowed === false) {
		logVerbose(`Blocked unauthorized slack sender ${senderId} (not in channel users)`);
		return null;
	}
	if (isRoom && isBotMessage && allowBotsMode !== "off" && !await authorizeSlackBotRoomMessage({
		ctx,
		channelId: message.channel,
		senderId,
		senderName: senderNameForAuth,
		channelUsers: channelConfig?.users,
		allowFromLower
	})) return null;
	if (isBotMessage && allowBotsMode === "mentions") {
		if (!(isDirectMessage || effectiveWasMentioned || shouldBypassMention)) {
			logVerbose("slack: drop bot message (allowBots=mentions, missing mention)");
			return null;
		}
	}
	const threadContextAllowFromLower = isRoom ? channelUsersAllowlistConfigured ? normalizeAllowListLower(channelConfig?.users) : [] : isDirectMessage ? allowFromLower : [];
	const contextVisibilityMode = resolveChannelContextVisibilityMode({
		cfg: ctx.cfg,
		channel: "slack",
		accountId: account.accountId
	});
	const commandAuthorized = messageIngress.commandAccess.authorized;
	if (isRoomish && messageIngress.commandAccess.shouldBlockControlCommand) {
		logInboundDrop({
			log: logVerbose,
			channel: "slack",
			reason: "control command (unauthorized)",
			target: senderId
		});
		return null;
	}
	if (isRoom && shouldRequireMention && messageIngress.activationAccess.shouldSkip) {
		ctx.logger.info({
			channel: message.channel,
			reason: "no-mention"
		}, "skipping channel message");
		const pendingText = (message.text ?? "").trim();
		const fallbackFile = message.files?.length ? `[Slack file: ${formatSlackFileReference(message.files[0])}]` : "";
		const pendingBody = pendingText || fallbackFile;
		recordPendingHistoryEntryIfEnabled({
			historyMap: ctx.channelHistories,
			historyKey,
			limit: ctx.historyLimit,
			entry: pendingBody ? {
				sender: await resolveSenderName(),
				body: pendingBody,
				timestamp: message.ts ? Math.round(Number(message.ts) * 1e3) : void 0,
				messageId: message.ts
			} : null
		});
		return null;
	}
	const threadStarter = isThreadReply && threadTs ? await resolveSlackThreadStarter({
		channelId: message.channel,
		threadTs,
		client: ctx.app.client
	}) : null;
	const resolvedMessageContent = await resolveSlackMessageContent({
		message,
		isThreadReply,
		threadStarter,
		isBotMessage,
		botToken: ctx.botToken,
		client: ctx.app.client,
		mediaMaxBytes: ctx.mediaMaxBytes,
		resolveUserName: ctx.resolveUserName
	});
	if (!resolvedMessageContent) return null;
	const { rawBody, effectiveDirectMedia } = resolvedMessageContent;
	const chatType = resolveSlackChatType(conversation.resolvedChannelType);
	const ackReaction = resolveAckReaction(cfg, route.agentId, {
		channel: "slack",
		accountId: account.accountId
	});
	const ackReactionValue = ackReaction ?? "";
	const sourceRepliesAreToolOnly = resolveChannelSourceReplyDeliveryMode({
		cfg,
		ctx: { ChatType: chatType }
	}) === "message_tool_only";
	const statusReactionsExplicitlyEnabled = cfg.messages?.statusReactions?.enabled === true;
	const shouldAckReaction$1 = () => Boolean(ackReaction && shouldAckReaction({
		scope: ctx.ackReactionScope,
		isDirect: isDirectMessage,
		isGroup: isRoomish,
		isMentionableGroup: isRoom,
		requireMention: shouldRequireMention,
		canDetectMention,
		effectiveWasMentioned,
		shouldBypassMention
	}));
	const ackReactionMessageTs = message.ts;
	const allowToolOnlyStatusReaction = statusReactionsExplicitlyEnabled && (effectiveWasMentioned || shouldBypassMention);
	const shouldSendAckReaction = shouldAckReaction$1() && (!sourceRepliesAreToolOnly || allowToolOnlyStatusReaction);
	const statusReactionsWillHandle = Boolean(ackReactionMessageTs) && cfg.messages?.statusReactions?.enabled !== false && shouldSendAckReaction;
	const ackReactionPromise = !statusReactionsWillHandle && shouldSendAckReaction && ackReactionMessageTs && ackReactionValue ? reactSlackMessage(message.channel, ackReactionMessageTs, ackReactionValue, {
		token: ctx.botToken,
		client: ctx.app.client
	}).then(() => true, (err) => {
		logVerbose(`slack react failed for channel ${message.channel}: ${formatSlackError(err)}`);
		return false;
	}) : statusReactionsWillHandle ? Promise.resolve(true) : null;
	const roomLabel = channelName ? `#${channelName}` : `#${message.channel}`;
	const senderName = await resolveSenderName();
	const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
	const inboundLabel = isDirectMessage ? `Slack DM from ${senderName}` : `Slack message in ${roomLabel} from ${senderName}`;
	const slackFrom = isDirectMessage ? `slack:${message.user}` : isRoom ? `slack:channel:${message.channel}` : `slack:group:${message.channel}`;
	enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
		sessionKey,
		contextKey: `slack:message:${message.channel}:${message.ts ?? "unknown"}`,
		trusted: false
	});
	const envelopeFrom = resolveConversationLabel({
		ChatType: chatType,
		SenderName: senderName,
		GroupSubject: isRoomish ? roomLabel : void 0,
		From: slackFrom
	}) ?? (isDirectMessage ? senderName : roomLabel);
	const threadInfo = isThreadReply && threadTs ? ` thread_ts: ${threadTs}${message.parent_user_id ? ` parent_user_id: ${message.parent_user_id}` : ""}` : "";
	const textWithId = `${rawBody}\n[slack message id: ${message.ts} channel: ${message.channel}${threadInfo}]`;
	const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId: route.agentId });
	const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
	const previousTimestamp = readSessionUpdatedAt({
		storePath,
		sessionKey
	});
	const dmHistoryLimit = isDirectMessage ? resolveSlackDmHistoryLimit({
		account,
		userId: message.user,
		defaultLimit: ctx.dmHistoryLimit
	}) : 0;
	let combinedBody = formatInboundEnvelope({
		channel: "Slack",
		from: envelopeFrom,
		timestamp: message.ts ? Math.round(Number(message.ts) * 1e3) : void 0,
		body: textWithId,
		chatType,
		sender: {
			name: senderName,
			id: senderId
		},
		previousTimestamp,
		envelope: envelopeOptions
	});
	const dmHistoryContext = isDirectMessage && !isThreadReply && dmHistoryLimit > 0 && !previousTimestamp ? await resolveSlackDmHistoryContext({
		ctx,
		channelId: message.channel,
		currentMessageTs: message.ts,
		limit: dmHistoryLimit,
		envelopeOptions
	}) : {
		body: void 0,
		inboundHistory: void 0
	};
	if (dmHistoryContext.body) combinedBody = `${dmHistoryContext.body}\n\n${combinedBody}`;
	if (isRoomish && ctx.historyLimit > 0) combinedBody = buildPendingHistoryContextFromMap({
		historyMap: ctx.channelHistories,
		historyKey,
		limit: ctx.historyLimit,
		currentMessage: combinedBody,
		formatEntry: (entry) => formatInboundEnvelope({
			channel: "Slack",
			from: roomLabel,
			timestamp: entry.timestamp,
			body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId} channel:${message.channel}]` : ""}`,
			chatType: "channel",
			senderLabel: entry.sender,
			envelope: envelopeOptions
		})
	});
	const slackTo = isDirectMessage ? `user:${message.user}` : `channel:${message.channel}`;
	const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
		isRoomish,
		channelInfo,
		channelConfig
	});
	const { threadStarterBody, threadHistoryBody, threadSessionPreviousTimestamp, threadLabel, threadStarterMedia } = await resolveSlackThreadContextData({
		ctx,
		account,
		message,
		isThreadReply,
		threadTs,
		threadStarter,
		roomLabel,
		storePath,
		sessionKey,
		allowFromLower: threadContextAllowFromLower,
		allowNameMatching: ctx.allowNameMatching,
		contextVisibilityMode,
		envelopeOptions,
		effectiveDirectMedia
	});
	const effectiveMedia = effectiveDirectMedia ?? threadStarterMedia;
	const firstMedia = effectiveMedia?.[0];
	const inboundHistory = isRoomish && ctx.historyLimit > 0 ? (ctx.channelHistories.get(historyKey) ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : dmHistoryContext.inboundHistory;
	const commandBody = textForCommandDetection.trim();
	const ctxPayload = finalizeInboundContext({
		Body: combinedBody,
		BodyForAgent: rawBody,
		InboundHistory: inboundHistory,
		RawBody: rawBody,
		CommandBody: commandBody,
		BodyForCommands: commandBody,
		From: slackFrom,
		To: slackTo,
		SessionKey: sessionKey,
		AccountId: route.accountId,
		ChatType: chatType,
		ConversationLabel: envelopeFrom,
		GroupSubject: isRoomish ? roomLabel : void 0,
		GroupSpace: ctx.teamId || void 0,
		GroupSystemPrompt: groupSystemPrompt,
		UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : void 0,
		SenderName: senderName,
		SenderId: senderId,
		Provider: "slack",
		Surface: "slack",
		MessageSid: message.ts,
		ReplyToId: threadContext.replyToId,
		MessageThreadId: threadContext.messageThreadId,
		ParentSessionKey: threadKeys.parentSessionKey,
		ThreadStarterBody: !threadSessionPreviousTimestamp ? threadStarterBody : void 0,
		ThreadHistoryBody: threadHistoryBody,
		IsFirstThreadTurn: isThreadReply && threadTs && !threadSessionPreviousTimestamp ? true : void 0,
		ThreadLabel: threadLabel,
		Timestamp: message.ts ? Math.round(Number(message.ts) * 1e3) : void 0,
		...buildSlackMentionContextPayload({
			isRoomish,
			effectiveWasMentioned,
			explicitlyMentioned,
			mentionedUserIds,
			mentionedSubteamIds,
			matchedImplicitMentionKinds,
			mentionSource
		}),
		MediaPath: firstMedia?.path,
		MediaType: firstMedia?.contentType,
		MediaUrl: firstMedia?.path,
		MediaPaths: effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : void 0,
		MediaUrls: effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : void 0,
		MediaTypes: effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.contentType ?? "") : void 0,
		CommandAuthorized: commandAuthorized,
		OriginatingChannel: "slack",
		OriginatingTo: slackTo,
		NativeChannelId: message.channel
	});
	if (isRoomish && !shouldRequireMention) recordPendingHistoryEntryIfEnabled({
		historyMap: ctx.channelHistories,
		historyKey,
		limit: ctx.historyLimit,
		entry: {
			sender: senderName,
			body: rawBody,
			timestamp: message.ts ? Math.round(Number(message.ts) * 1e3) : void 0,
			messageId: message.ts
		}
	});
	const pinnedMainDmOwner = isDirectMessage ? resolvePinnedMainDmOwnerFromAllowlist({
		dmScope: cfg.session?.dmScope,
		allowFrom: ctx.allowFrom,
		normalizeEntry: normalizeSlackAllowOwnerEntry
	}) : null;
	const replyTarget = isDirectMessage ? `channel:${message.channel}` : ctxPayload.To ?? void 0;
	if (!replyTarget) return null;
	if (shouldLogVerbose()) logVerbose(`slack inbound: channel=${message.channel} from=${slackFrom} preview="${preview}"`);
	return {
		ctx,
		account,
		message,
		route,
		channelConfig,
		replyTarget,
		ctxPayload,
		turn: {
			storePath,
			record: {
				updateLastRoute: isDirectMessage ? {
					sessionKey: resolveInboundLastRouteSessionKey({
						route,
						sessionKey
					}),
					channel: "slack",
					to: `user:${message.user}`,
					accountId: route.accountId,
					threadId: threadContext.messageThreadId,
					mainDmOwnerPin: pinnedMainDmOwner && message.user ? {
						ownerRecipient: pinnedMainDmOwner,
						senderRecipient: normalizeLowercaseStringOrEmpty(message.user),
						onSkip: ({ ownerRecipient, senderRecipient }) => {
							logVerbose(`slack: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
						}
					} : void 0
				} : void 0,
				onRecordError: (err) => {
					ctx.logger.warn({
						error: formatErrorMessage(err),
						storePath,
						sessionKey
					}, "failed updating session meta");
				}
			}
		},
		replyToMode,
		requireMention: shouldRequireMention,
		isDirectMessage,
		isRoomish,
		historyKey,
		preview,
		ackReactionMessageTs,
		ackReactionValue,
		ackReactionPromise
	};
}
//#endregion
export { resolveSlackThreadTargets as n, prepareSlackMessage as t };
