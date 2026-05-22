import { c as isRecord, y as truncateUtf16Safe } from "./utils-D5swhEXt.js";
import { s as normalizeStringEntries } from "./string-normalization-C5SGsaST.js";
import { t as createNonExitingRuntime } from "./runtime-bzt9CHmD.js";
import { a as shouldLogVerbose, r as logVerbose, s as warn, t as danger } from "./globals-BHVmraBM.js";
import { i as getRuntimeConfig } from "./io-DOE5w-Qp.js";
import { t as sanitizeTerminalText } from "./safe-text-BT4s_OgE.js";
import { r as normalizeScpRemoteHost } from "./scp-host-B-cQJNgc.js";
import { t as isInboundPathAllowed } from "./inbound-path-policy-D-CKDsUn.js";
import { u as resolveStorePath } from "./paths-B_upRR9g.js";
import { n as readSessionUpdatedAt } from "./store-D-yqyA6X.js";
import { r as stripInlineDirectiveTagsForDelivery } from "./directive-tags-XF4RaTeD.js";
import { f as findCodeRegions, i as stripAssistantInternalScaffolding, p as isInsideCode } from "./assistant-visible-text-Bwhl71M-.js";
import { c as kindFromMime } from "./mime-CJtvravN.js";
import { i as deliverTextOrMediaReply, m as resolveSendableOutboundReplyParts } from "./reply-payload-sdgmUR9u.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-D12HbfWW.js";
import { c as resolveTextChunkLimit, o as chunkTextWithMode, s as resolveChunkMode } from "./chunk-8IibRYUU.js";
import { i as resolveAgentRoute } from "./resolve-route-DVPSW7ZD.js";
import { i as resolveHumanDelayConfig } from "./identity-GoxySUrw.js";
import { t as resolveOutboundAttachmentFromUrl } from "./outbound-attachment-BX3ZXRkA.js";
import { i as createReplyDispatcher, s as settleReplyDispatcher, t as dispatchInboundMessage } from "./dispatch-D-avvp6L.js";
import { n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-Dro8jben.js";
import { t as finalizeInboundContext } from "./inbound-context-DxHLdYeq.js";
import { t as convertMarkdownTables } from "./tables-pL4TCKht.js";
import "./text-runtime-DCigKjjg.js";
import "./routing-DX0cHvtC.js";
import { t as hasControlCommand } from "./command-detection-CiaCccCf.js";
import { a as resolveEnvelopeFormatOptions, i as formatInboundFromLabel, r as formatInboundEnvelope } from "./envelope-lm8THMaA.js";
import { r as resolveDualTextControlCommandGate } from "./command-gating-DWZSxKl4.js";
import { n as resolveInboundMentionDecision } from "./mention-gating-8EmYZvQ3.js";
import { t as recordInboundSession } from "./session-BK_u55Mv.js";
import { d as recordPendingHistoryEntryIfEnabled, o as buildPendingHistoryContextFromMap } from "./history-Cg-sRk_e.js";
import { t as evaluateSupplementalContextVisibility } from "./context-visibility-D0yYlHrp.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-BZqriDIP.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-B07-m5O1.js";
import { t as createChannelReplyPipeline } from "./channel-reply-pipeline-DR9vcaJj.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-D9CzvFBY.js";
import "./channel-policy-5FBdjNP7.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist, o as resolveDmGroupAccessWithLists, t as DM_GROUP_ACCESS_REASON } from "./dm-policy-shared-WPgrRbHo.js";
import "./reply-history-BZ5LBzDD.js";
import { n as logInboundDrop } from "./logging-CNzRDGaV.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing-BI_ZJIJ_.js";
import "./runtime-env-DVyvKnep.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-BDAD-n-2.js";
import { t as resolveChannelContextVisibilityMode } from "./context-visibility-D6L6JQmC.js";
import "./reply-runtime-CgdKC_bo.js";
import { a as runInboundReplyTurn } from "./inbound-reply-dispatch-B0ZjYKzs.js";
import { t as waitForTransportReady } from "./transport-ready-C8_9OO_l.js";
import "./transport-ready-runtime-Byps-WKn.js";
import "./runtime-config-snapshot-v7W2zNnN.js";
import "./media-runtime-B3sgGdPE.js";
import { n as resolveConfiguredBindingRoute, r as resolveRuntimeConversationBindingRoute } from "./binding-routing-BSsRjIJE.js";
import "./conversation-runtime-C56BaCAE.js";
import "./agent-runtime-Df1vJZj4.js";
import "./security-runtime-CbBYpvzI.js";
import "./markdown-table-runtime-DBY5MqUd.js";
import "./command-auth-BUcu6hT5.js";
import { n as createChannelInboundDebouncer, r as shouldDebounceTextInbound } from "./channel-inbound-C8PftHv8.js";
import "./session-store-runtime-CeD_IJ8J.js";
import { n as resolveIMessageAttachmentRoots, r as resolveIMessageRemoteAttachmentRoots, s as resolveIMessageAccount } from "./media-contract-DLrXQ0zX.js";
import { a as formatIMessageChatTarget, d as parseIMessageTarget, l as normalizeIMessageHandle, s as isAllowedIMessageSender, t as resolveIMessageInboundConversationId } from "./conversation-id-DTDTBN3Z.js";
import { n as createIMessageRpcClient, t as probeIMessage } from "./probe-szO3leT0.js";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
//#region extensions/imessage/src/send.ts
const MAX_REPLY_TO_ID_LENGTH = 256;
function stripUnsafeReplyTagChars(value) {
	let next = "";
	for (const ch of value) {
		const code = ch.charCodeAt(0);
		if (code >= 0 && code <= 31 || code === 127 || ch === "[" || ch === "]") continue;
		next += ch;
	}
	return next;
}
function sanitizeReplyToId(rawReplyToId) {
	const trimmed = rawReplyToId?.trim();
	if (!trimmed) return;
	const sanitized = stripUnsafeReplyTagChars(trimmed).trim();
	if (!sanitized) return;
	if (sanitized.length > MAX_REPLY_TO_ID_LENGTH) return sanitized.slice(0, MAX_REPLY_TO_ID_LENGTH);
	return sanitized;
}
function resolveMessageId(result) {
	if (!result) return null;
	const raw = typeof result.messageId === "string" && result.messageId.trim() || typeof result.message_id === "string" && result.message_id.trim() || typeof result.id === "string" && result.id.trim() || typeof result.guid === "string" && result.guid.trim() || (typeof result.message_id === "number" ? String(result.message_id) : null) || (typeof result.id === "number" ? String(result.id) : null);
	return raw ? raw.trim() : null;
}
function resolveDeliveredIMessageText(text, mediaContentType) {
	if (text.trim()) return text;
	const kind = kindFromMime(mediaContentType ?? void 0);
	if (!kind) return text;
	return kind === "image" ? "<media:image>" : `<media:${kind}>`;
}
async function sendMessageIMessage(to, text, opts) {
	const cfg = requireRuntimeConfig(opts.config, "iMessage send");
	const account = opts.account ?? resolveIMessageAccount({
		cfg,
		accountId: opts.accountId
	});
	const cliPath = opts.cliPath?.trim() || account.config.cliPath?.trim() || "imsg";
	const dbPath = opts.dbPath?.trim() || account.config.dbPath?.trim();
	const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
	const service = opts.service ?? (target.kind === "handle" ? target.service : void 0) ?? account.config.service;
	const region = opts.region?.trim() || account.config.region?.trim() || "US";
	const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb * 1024 * 1024 : 16 * 1024 * 1024;
	let message = text ?? "";
	let filePath;
	if (opts.mediaUrl?.trim()) {
		const resolved = await (opts.resolveAttachmentImpl ?? resolveOutboundAttachmentFromUrl)(opts.mediaUrl.trim(), maxBytes, {
			localRoots: opts.mediaLocalRoots,
			readFile: opts.mediaReadFile
		});
		filePath = resolved.path;
		message = resolveDeliveredIMessageText(message, resolved.contentType ?? void 0);
	}
	if (!message.trim() && !filePath) throw new Error("iMessage send requires text or media");
	if (message.trim()) {
		const tableMode = resolveMarkdownTableMode({
			cfg,
			channel: "imessage",
			accountId: account.accountId
		});
		message = convertMarkdownTables(message, tableMode);
	}
	message = stripInlineDirectiveTagsForDelivery(message).text;
	if (!message.trim() && !filePath) throw new Error("iMessage send requires text or media");
	const resolvedReplyToId = sanitizeReplyToId(opts.replyToId);
	const params = {
		text: message,
		service: service || "auto",
		region
	};
	if (resolvedReplyToId) params.reply_to = resolvedReplyToId;
	if (filePath) params.file = filePath;
	if (target.kind === "chat_id") params.chat_id = target.chatId;
	else if (target.kind === "chat_guid") params.chat_guid = target.chatGuid;
	else if (target.kind === "chat_identifier") params.chat_identifier = target.chatIdentifier;
	else params.to = target.to;
	const client = opts.client ?? (opts.createClient ? await opts.createClient({
		cliPath,
		dbPath
	}) : await createIMessageRpcClient({
		cliPath,
		dbPath
	}));
	const shouldClose = !opts.client;
	try {
		const result = await client.request("send", params, { timeoutMs: opts.timeoutMs });
		return {
			messageId: resolveMessageId(result) ?? (result?.ok ? "ok" : "unknown"),
			sentText: message
		};
	} finally {
		if (shouldClose) await client.stop();
	}
}
//#endregion
//#region extensions/imessage/src/monitor/abort-handler.ts
function attachIMessageMonitorAbortHandler(params) {
	const abort = params.abortSignal;
	if (!abort) return () => {};
	const onAbort = () => {
		const subscriptionId = params.getSubscriptionId();
		if (subscriptionId) params.client.request("watch.unsubscribe", { subscription: subscriptionId }).catch(() => {});
		params.client.stop().catch(() => {});
	};
	abort.addEventListener("abort", onAbort, { once: true });
	return () => abort.removeEventListener("abort", onAbort);
}
//#endregion
//#region extensions/imessage/src/monitor/sanitize-outbound.ts
/**
* Patterns that indicate assistant-internal metadata leaked into text.
* These must never reach a user-facing channel.
*/
const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
const ROLE_TURN_MARKER_RE = /\b(?:user|system|assistant)\s*:\s*$/gm;
/**
* Strip all assistant-internal scaffolding from outbound text before delivery.
* Applies reasoning/thinking tag removal, memory tag removal, and
* model-specific internal separator stripping.
*/
function sanitizeOutboundText(text) {
	if (!text) return text;
	let cleaned = stripAssistantInternalScaffolding(text);
	cleaned = cleaned.replace(INTERNAL_SEPARATOR_RE, "");
	cleaned = cleaned.replace(ASSISTANT_ROLE_MARKER_RE, "");
	cleaned = cleaned.replace(ROLE_TURN_MARKER_RE, "");
	cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
	return cleaned;
}
//#endregion
//#region extensions/imessage/src/monitor/deliver.ts
async function deliverReplies(params) {
	const { replies, target, client, runtime, maxBytes, textLimit, accountId, sentMessageCache } = params;
	const scope = `${accountId ?? ""}:${target}`;
	const { cfg } = params;
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "imessage",
		accountId
	});
	const chunkMode = resolveChunkMode(cfg, "imessage", accountId);
	for (const payload of replies) if (await deliverTextOrMediaReply({
		payload,
		text: resolveSendableOutboundReplyParts(payload, { text: convertMarkdownTables(sanitizeOutboundText(payload.text ?? ""), tableMode) }).text,
		chunkText: (value) => chunkTextWithMode(value, textLimit, chunkMode),
		sendText: async (chunk) => {
			const sent = await sendMessageIMessage(target, chunk, {
				config: params.cfg,
				maxBytes,
				client,
				accountId,
				replyToId: payload.replyToId
			});
			sentMessageCache?.remember(scope, {
				text: sent.sentText,
				messageId: sent.messageId
			});
		},
		sendMedia: async ({ mediaUrl, caption }) => {
			const sent = await sendMessageIMessage(target, caption ?? "", {
				config: params.cfg,
				mediaUrl,
				maxBytes,
				client,
				accountId,
				replyToId: payload.replyToId
			});
			sentMessageCache?.remember(scope, {
				text: sent.sentText || void 0,
				messageId: sent.messageId
			});
		}
	}) !== "empty") runtime.log?.(`imessage: delivered reply to ${target}`);
}
//#endregion
//#region extensions/imessage/src/monitor/echo-cache.ts
const SENT_MESSAGE_TEXT_TTL_MS = 4e3;
const SENT_MESSAGE_ID_TTL_MS = 6e4;
const LEADING_ATTRIBUTED_BODY_CORRUPTION_MARKERS = /^[\uFEFF\uFFFD\uFFFE\uFFFF]+/u;
function normalizeEchoTextKey(text) {
	if (!text) return null;
	const normalized = text.replace(/\r\n?/g, "\n").trim().replace(LEADING_ATTRIBUTED_BODY_CORRUPTION_MARKERS, "").trim();
	return normalized ? normalized : null;
}
function normalizeEchoMessageIdKey(messageId) {
	if (!messageId) return null;
	const normalized = messageId.trim();
	if (!normalized || normalized === "ok" || normalized === "unknown") return null;
	return normalized;
}
var DefaultSentMessageCache = class {
	constructor() {
		this.textCache = /* @__PURE__ */ new Map();
		this.textBackedByIdCache = /* @__PURE__ */ new Map();
		this.messageIdCache = /* @__PURE__ */ new Map();
	}
	remember(scope, lookup) {
		const textKey = normalizeEchoTextKey(lookup.text);
		if (textKey) this.textCache.set(`${scope}:${textKey}`, Date.now());
		const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
		if (messageIdKey) {
			this.messageIdCache.set(`${scope}:${messageIdKey}`, Date.now());
			if (textKey) this.textBackedByIdCache.set(`${scope}:${textKey}`, Date.now());
		}
		this.cleanup();
	}
	has(scope, lookup, skipIdShortCircuit = false) {
		this.cleanup();
		const textKey = normalizeEchoTextKey(lookup.text);
		const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
		if (messageIdKey) {
			const idTimestamp = this.messageIdCache.get(`${scope}:${messageIdKey}`);
			if (idTimestamp && Date.now() - idTimestamp <= SENT_MESSAGE_ID_TTL_MS) return true;
			const textTimestamp = textKey ? this.textCache.get(`${scope}:${textKey}`) : void 0;
			const textBackedByIdTimestamp = textKey ? this.textBackedByIdCache.get(`${scope}:${textKey}`) : void 0;
			if (!skipIdShortCircuit && !(typeof textTimestamp === "number" && (!textBackedByIdTimestamp || textTimestamp > textBackedByIdTimestamp))) return false;
		}
		if (textKey) {
			const textTimestamp = this.textCache.get(`${scope}:${textKey}`);
			if (textTimestamp && Date.now() - textTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) return true;
		}
		return false;
	}
	cleanup() {
		const now = Date.now();
		for (const [key, timestamp] of this.textCache.entries()) if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) this.textCache.delete(key);
		for (const [key, timestamp] of this.textBackedByIdCache.entries()) if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) this.textBackedByIdCache.delete(key);
		for (const [key, timestamp] of this.messageIdCache.entries()) if (now - timestamp > SENT_MESSAGE_ID_TTL_MS) this.messageIdCache.delete(key);
	}
};
function createSentMessageCache() {
	return new DefaultSentMessageCache();
}
//#endregion
//#region extensions/imessage/src/conversation-route.ts
function resolveIMessageConversationRoute(params) {
	let route = resolveAgentRoute({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId,
		peer: {
			kind: params.isGroup ? "group" : "direct",
			id: params.peerId
		}
	});
	const conversationId = resolveIMessageInboundConversationId({
		isGroup: params.isGroup,
		sender: params.sender,
		chatId: params.chatId
	});
	if (!conversationId) return route;
	route = resolveConfiguredBindingRoute({
		cfg: params.cfg,
		route,
		conversation: {
			channel: "imessage",
			accountId: params.accountId,
			conversationId
		}
	}).route;
	const runtimeRoute = resolveRuntimeConversationBindingRoute({
		route,
		conversation: {
			channel: "imessage",
			accountId: params.accountId,
			conversationId
		}
	});
	route = runtimeRoute.route;
	if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) logVerbose(`imessage: plugin-bound conversation ${conversationId}`);
	else if (runtimeRoute.boundSessionKey) logVerbose(`imessage: routed via bound conversation ${conversationId} -> ${runtimeRoute.boundSessionKey}`);
	return route;
}
//#endregion
//#region extensions/imessage/src/monitor/reflection-guard.ts
/**
* Detects inbound messages that are reflections of assistant-originated content.
* These patterns indicate internal metadata leaked into a channel and then
* bounced back as a new inbound message — creating an echo loop.
*/
const REFLECTION_PATTERNS = [
	{
		re: /(?:#\+){2,}#?/,
		label: "internal-separator"
	},
	{
		re: /\bassistant\s+to\s*=\s*\w+/i,
		label: "assistant-role-marker"
	},
	{
		re: /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/i,
		label: "thinking-tag"
	},
	{
		re: /<\s*\/?\s*relevant[-_]memories\b[^<>]*>/i,
		label: "relevant-memories-tag"
	},
	{
		re: /<\s*\/?\s*final\b[^<>]*>/i,
		label: "final-tag"
	}
];
function hasMatchOutsideCode(text, re) {
	const codeRegions = findCodeRegions(text);
	const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
	for (const match of text.matchAll(globalRe)) {
		const start = match.index ?? -1;
		if (start >= 0 && !isInsideCode(start, codeRegions)) return true;
	}
	return false;
}
/**
* Check whether an inbound message appears to be a reflection of
* assistant-originated content. Returns matched pattern labels for telemetry.
*/
function detectReflectedContent(text) {
	if (!text) return {
		isReflection: false,
		matchedLabels: []
	};
	const matchedLabels = [];
	for (const { re, label } of REFLECTION_PATTERNS) if (hasMatchOutsideCode(text, re)) matchedLabels.push(label);
	return {
		isReflection: matchedLabels.length > 0,
		matchedLabels
	};
}
//#endregion
//#region extensions/imessage/src/monitor/inbound-processing.ts
function normalizeReplyField(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : void 0;
	}
	if (typeof value === "number") return String(value);
}
function describeReplyContext(message) {
	const body = normalizeReplyField(message.reply_to_text);
	if (!body) return null;
	return {
		body,
		id: normalizeReplyField(message.reply_to_id),
		sender: normalizeReplyField(message.reply_to_sender)
	};
}
function resolveInboundEchoMessageIds(message) {
	const values = [message.id != null ? String(message.id) : void 0, normalizeReplyField(message.guid)];
	const ids = [];
	for (const value of values) {
		if (!value || ids.includes(value)) continue;
		ids.push(value);
	}
	return ids;
}
function hasIMessageEchoMatch(params) {
	for (const messageId of params.messageIds) if (params.echoCache.has(params.scope, { messageId })) return true;
	const fallbackMessageId = params.messageIds[0];
	if (!params.text && !fallbackMessageId) return false;
	return params.echoCache.has(params.scope, {
		text: params.text,
		messageId: fallbackMessageId
	}, params.skipIdShortCircuit);
}
function resolveIMessageInboundDecision(params) {
	const sender = (params.message.sender ?? "").trim();
	if (!sender) return {
		kind: "drop",
		reason: "missing sender"
	};
	const senderNormalized = normalizeIMessageHandle(sender);
	const chatId = params.message.chat_id ?? void 0;
	const chatGuid = params.message.chat_guid ?? void 0;
	const chatIdentifier = params.message.chat_identifier ?? void 0;
	const destinationCallerId = params.message.destination_caller_id ?? void 0;
	const createdAt = params.message.created_at ? Date.parse(params.message.created_at) : void 0;
	const messageText = params.messageText.trim();
	const bodyText = params.bodyText.trim();
	const groupIdCandidate = chatId !== void 0 ? String(chatId) : void 0;
	const groupListPolicy = groupIdCandidate ? resolveChannelGroupPolicy({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId,
		groupId: groupIdCandidate
	}) : {
		allowlistEnabled: false,
		allowed: true,
		groupConfig: void 0,
		defaultConfig: void 0
	};
	const treatAsGroupByConfig = Boolean(groupIdCandidate && groupListPolicy.allowlistEnabled && groupListPolicy.groupConfig);
	const isGroup = Boolean(params.message.is_group) || treatAsGroupByConfig;
	const selfChatLookup = {
		accountId: params.accountId,
		isGroup,
		chatId,
		sender,
		text: bodyText,
		createdAt
	};
	const chatIdentifierNormalized = normalizeIMessageHandle(chatIdentifier ?? "") || void 0;
	const destinationCallerIdNormalized = normalizeIMessageHandle(destinationCallerId ?? "") || void 0;
	const isSelfChat = !isGroup && chatIdentifierNormalized != null && senderNormalized === chatIdentifierNormalized && destinationCallerIdNormalized != null && destinationCallerIdNormalized === senderNormalized;
	const isAmbiguousSelfThread = !isGroup && chatIdentifierNormalized != null && senderNormalized === chatIdentifierNormalized && destinationCallerIdNormalized == null;
	let skipSelfChatHasCheck = false;
	const inboundMessageIds = resolveInboundEchoMessageIds(params.message);
	const inboundMessageId = inboundMessageIds[0];
	const hasInboundGuid = Boolean(normalizeReplyField(params.message.guid));
	if (params.message.is_from_me) {
		if (isAmbiguousSelfThread) params.selfChatCache?.remember(selfChatLookup);
		if (isSelfChat) {
			params.selfChatCache?.remember(selfChatLookup);
			const echoScope = buildIMessageEchoScope({
				accountId: params.accountId,
				isGroup,
				chatId,
				sender
			});
			if (params.echoCache && (bodyText || inboundMessageId) && hasIMessageEchoMatch({
				echoCache: params.echoCache,
				scope: echoScope,
				text: bodyText || void 0,
				messageIds: inboundMessageIds,
				skipIdShortCircuit: !hasInboundGuid
			})) return {
				kind: "drop",
				reason: "agent echo in self-chat"
			};
			skipSelfChatHasCheck = true;
		} else return {
			kind: "drop",
			reason: "from me"
		};
	}
	if (isGroup && !chatId) return {
		kind: "drop",
		reason: "group without chat_id"
	};
	const groupId = isGroup ? groupIdCandidate : void 0;
	const accessDecision = resolveDmGroupAccessWithLists({
		isGroup,
		dmPolicy: params.dmPolicy,
		groupPolicy: params.groupPolicy,
		allowFrom: params.allowFrom,
		groupAllowFrom: params.groupAllowFrom,
		storeAllowFrom: params.storeAllowFrom,
		groupAllowFromFallbackToAllowFrom: false,
		isSenderAllowed: (allowFrom) => isAllowedIMessageSender({
			allowFrom,
			sender,
			chatId,
			chatGuid,
			chatIdentifier
		})
	});
	const effectiveDmAllowFrom = accessDecision.effectiveAllowFrom;
	const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
	if (accessDecision.decision !== "allow") {
		if (isGroup) {
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
				params.logVerbose?.("Blocked iMessage group message (groupPolicy: disabled)");
				return {
					kind: "drop",
					reason: "groupPolicy disabled"
				};
			}
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
				params.logVerbose?.("Blocked iMessage group message (groupPolicy: allowlist, no groupAllowFrom)");
				return {
					kind: "drop",
					reason: "groupPolicy allowlist (empty groupAllowFrom)"
				};
			}
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
				params.logVerbose?.(`Blocked iMessage sender ${sender} (not in groupAllowFrom)`);
				return {
					kind: "drop",
					reason: "not in groupAllowFrom"
				};
			}
			params.logVerbose?.(`Blocked iMessage group message (${accessDecision.reason})`);
			return {
				kind: "drop",
				reason: accessDecision.reason
			};
		}
		if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) return {
			kind: "drop",
			reason: "dmPolicy disabled"
		};
		if (accessDecision.decision === "pairing") return {
			kind: "pairing",
			senderId: senderNormalized
		};
		params.logVerbose?.(`Blocked iMessage sender ${sender} (dmPolicy=${params.dmPolicy})`);
		return {
			kind: "drop",
			reason: "dmPolicy blocked"
		};
	}
	if (isGroup && groupListPolicy.allowlistEnabled && !groupListPolicy.allowed) {
		params.logVerbose?.(`imessage: skipping group message (${groupId ?? "unknown"}) not in allowlist`);
		return {
			kind: "drop",
			reason: "group id not in allowlist"
		};
	}
	const route = resolveIMessageConversationRoute({
		cfg: params.cfg,
		accountId: params.accountId,
		isGroup,
		peerId: isGroup ? String(chatId ?? "unknown") : senderNormalized,
		sender,
		chatId
	});
	const mentionRegexes = buildMentionRegexes(params.cfg, route.agentId);
	if (!bodyText) return {
		kind: "drop",
		reason: "empty body"
	};
	if (skipSelfChatHasCheck ? false : params.selfChatCache?.has({
		...selfChatLookup,
		text: bodyText
	})) {
		const preview = sanitizeTerminalText(truncateUtf16Safe(bodyText, 50));
		params.logVerbose?.(`imessage: dropping self-chat reflected duplicate: "${preview}"`);
		return {
			kind: "drop",
			reason: "self-chat echo"
		};
	}
	if (params.echoCache && (messageText || inboundMessageId)) {
		const echoScope = buildIMessageEchoScope({
			accountId: params.accountId,
			isGroup,
			chatId,
			sender
		});
		if (hasIMessageEchoMatch({
			echoCache: params.echoCache,
			scope: echoScope,
			text: bodyText || void 0,
			messageIds: inboundMessageIds
		})) {
			params.logVerbose?.(describeIMessageEchoDropLog({
				messageText: bodyText,
				messageId: inboundMessageId
			}));
			return {
				kind: "drop",
				reason: "echo"
			};
		}
	}
	const reflection = detectReflectedContent(messageText);
	if (reflection.isReflection) {
		params.logVerbose?.(`imessage: dropping reflected assistant content (markers: ${reflection.matchedLabels.join(", ")})`);
		return {
			kind: "drop",
			reason: "reflected assistant content"
		};
	}
	const replyContext = describeReplyContext(params.message);
	const contextVisibilityMode = resolveChannelContextVisibilityMode({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId
	});
	const replySenderAllowed = !isGroup || effectiveGroupAllowFrom.length === 0 ? true : replyContext?.sender ? isAllowedIMessageSender({
		allowFrom: effectiveGroupAllowFrom,
		sender: replyContext.sender,
		chatId,
		chatGuid,
		chatIdentifier
	}) : false;
	const filteredReplyContext = !replyContext || evaluateSupplementalContextVisibility({
		mode: contextVisibilityMode,
		kind: "quote",
		senderAllowed: replySenderAllowed
	}).include ? replyContext : null;
	if (replyContext && !filteredReplyContext && isGroup) params.logVerbose?.(`imessage: drop reply context (mode=${contextVisibilityMode}, sender_allowed=${replySenderAllowed ? "yes" : "no"})`);
	const historyKey = isGroup ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown") : void 0;
	const mentioned = isGroup ? matchesMentionPatterns(messageText, mentionRegexes) : true;
	const requireMention = resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId,
		groupId,
		requireMentionOverride: params.opts?.requireMention,
		overrideOrder: "before-config"
	});
	const canDetectMention = mentionRegexes.length > 0;
	const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
	const commandDmAllowFrom = isGroup ? params.allowFrom : effectiveDmAllowFrom;
	const ownerAllowedForCommands = commandDmAllowFrom.length > 0 ? isAllowedIMessageSender({
		allowFrom: commandDmAllowFrom,
		sender,
		chatId,
		chatGuid,
		chatIdentifier
	}) : false;
	const groupAllowedForCommands = effectiveGroupAllowFrom.length > 0 ? isAllowedIMessageSender({
		allowFrom: effectiveGroupAllowFrom,
		sender,
		chatId,
		chatGuid,
		chatIdentifier
	}) : false;
	const hasControlCommandInMessage = hasControlCommand(messageText, params.cfg);
	const { commandAuthorized, shouldBlock } = resolveDualTextControlCommandGate({
		useAccessGroups,
		primaryConfigured: commandDmAllowFrom.length > 0,
		primaryAllowed: ownerAllowedForCommands,
		secondaryConfigured: effectiveGroupAllowFrom.length > 0,
		secondaryAllowed: groupAllowedForCommands,
		hasControlCommand: hasControlCommandInMessage
	});
	if (isGroup && shouldBlock) {
		if (params.logVerbose) logInboundDrop({
			log: params.logVerbose,
			channel: "imessage",
			reason: "control command (unauthorized)",
			target: sender
		});
		return {
			kind: "drop",
			reason: "control command (unauthorized)"
		};
	}
	const mentionDecision = resolveInboundMentionDecision({
		facts: {
			canDetectMention,
			wasMentioned: mentioned,
			hasAnyMention: false,
			implicitMentionKinds: []
		},
		policy: {
			isGroup,
			requireMention,
			allowTextCommands: true,
			hasControlCommand: hasControlCommandInMessage,
			commandAuthorized
		}
	});
	const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
	if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
		params.logVerbose?.(`imessage: skipping group message (no mention)`);
		recordPendingHistoryEntryIfEnabled({
			historyMap: params.groupHistories,
			historyKey: historyKey ?? "",
			limit: params.historyLimit,
			entry: historyKey ? {
				sender: senderNormalized,
				body: bodyText,
				timestamp: createdAt,
				messageId: params.message.id ? String(params.message.id) : void 0
			} : null
		});
		return {
			kind: "drop",
			reason: "no mention"
		};
	}
	return {
		kind: "dispatch",
		isGroup,
		chatId,
		chatGuid,
		chatIdentifier,
		groupId,
		historyKey,
		sender,
		senderNormalized,
		route,
		bodyText,
		createdAt,
		replyContext: filteredReplyContext,
		effectiveWasMentioned,
		commandAuthorized,
		effectiveDmAllowFrom,
		effectiveGroupAllowFrom
	};
}
function buildIMessageInboundContext(params) {
	const envelopeOptions = params.envelopeOptions ?? resolveEnvelopeFormatOptions(params.cfg);
	const { decision } = params;
	const chatId = decision.chatId;
	const chatTarget = decision.isGroup && chatId != null ? formatIMessageChatTarget(chatId) : void 0;
	const replySuffix = decision.replyContext ? `\n\n[Replying to ${decision.replyContext.sender ?? "unknown sender"}${decision.replyContext.id ? ` id:${decision.replyContext.id}` : ""}]\n${decision.replyContext.body}\n[/Replying]` : "";
	const fromLabel = formatInboundFromLabel({
		isGroup: decision.isGroup,
		groupLabel: params.message.chat_name ?? void 0,
		groupId: chatId !== void 0 ? String(chatId) : "unknown",
		groupFallback: "Group",
		directLabel: decision.senderNormalized,
		directId: decision.sender
	});
	let combinedBody = formatInboundEnvelope({
		channel: "iMessage",
		from: fromLabel,
		timestamp: decision.createdAt,
		body: `${decision.bodyText}${replySuffix}`,
		chatType: decision.isGroup ? "group" : "direct",
		sender: {
			name: decision.senderNormalized,
			id: decision.sender
		},
		previousTimestamp: params.previousTimestamp,
		envelope: envelopeOptions
	});
	if (decision.isGroup && decision.historyKey) combinedBody = buildPendingHistoryContextFromMap({
		historyMap: params.groupHistories,
		historyKey: decision.historyKey,
		limit: params.historyLimit,
		currentMessage: combinedBody,
		formatEntry: (entry) => formatInboundEnvelope({
			channel: "iMessage",
			from: fromLabel,
			timestamp: entry.timestamp,
			body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
			chatType: "group",
			senderLabel: entry.sender,
			envelope: envelopeOptions
		})
	});
	const imessageTo = (decision.isGroup ? chatTarget : void 0) || `imessage:${decision.sender}`;
	const inboundHistory = decision.isGroup && decision.historyKey && params.historyLimit > 0 ? (params.groupHistories.get(decision.historyKey) ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : void 0;
	return {
		ctxPayload: finalizeInboundContext({
			Body: combinedBody,
			BodyForAgent: decision.bodyText,
			InboundHistory: inboundHistory,
			RawBody: decision.bodyText,
			CommandBody: decision.bodyText,
			From: decision.isGroup ? `imessage:group:${chatId ?? "unknown"}` : `imessage:${decision.sender}`,
			To: imessageTo,
			SessionKey: decision.route.sessionKey,
			AccountId: decision.route.accountId,
			ChatType: decision.isGroup ? "group" : "direct",
			ConversationLabel: fromLabel,
			GroupSubject: decision.isGroup ? params.message.chat_name ?? void 0 : void 0,
			GroupMembers: decision.isGroup ? (params.message.participants ?? []).filter(Boolean).join(", ") : void 0,
			SenderName: decision.senderNormalized,
			SenderId: decision.sender,
			Provider: "imessage",
			Surface: "imessage",
			MessageSid: params.message.id ? String(params.message.id) : void 0,
			ReplyToId: decision.replyContext?.id,
			ReplyToBody: decision.replyContext?.body,
			ReplyToSender: decision.replyContext?.sender,
			Timestamp: decision.createdAt,
			MediaPath: params.media?.path,
			MediaType: params.media?.type,
			MediaUrl: params.media?.path,
			MediaPaths: params.media?.paths && params.media.paths.length > 0 ? params.media.paths : void 0,
			MediaTypes: params.media?.types && params.media.types.length > 0 ? params.media.types : void 0,
			MediaUrls: params.media?.paths && params.media.paths.length > 0 ? params.media.paths : void 0,
			MediaRemoteHost: params.remoteHost,
			WasMentioned: decision.effectiveWasMentioned,
			CommandAuthorized: decision.commandAuthorized,
			OriginatingChannel: "imessage",
			OriginatingTo: imessageTo
		}),
		fromLabel,
		chatTarget,
		imessageTo,
		inboundHistory
	};
}
function buildIMessageEchoScope(params) {
	return `${params.accountId}:${params.isGroup ? formatIMessageChatTarget(params.chatId) : `imessage:${params.sender}`}`;
}
function describeIMessageEchoDropLog(params) {
	const preview = truncateUtf16Safe(params.messageText, 50);
	return `imessage: skipping echo message${params.messageId ? ` id=${params.messageId}` : ""}: "${preview}"`;
}
//#endregion
//#region extensions/imessage/src/monitor/loop-rate-limiter.ts
/**
* Per-conversation rate limiter that detects rapid-fire identical echo
* patterns and suppresses them before they amplify into queue overflow.
*/
const DEFAULT_WINDOW_MS = 6e4;
const DEFAULT_MAX_HITS = 5;
const CLEANUP_INTERVAL_MS = 12e4;
function createLoopRateLimiter(opts) {
	const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
	const maxHits = opts?.maxHits ?? DEFAULT_MAX_HITS;
	const conversations = /* @__PURE__ */ new Map();
	let lastCleanup = Date.now();
	function cleanup() {
		const now = Date.now();
		if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
		lastCleanup = now;
		for (const [key, win] of conversations.entries()) {
			const recent = win.timestamps.filter((ts) => now - ts <= windowMs);
			if (recent.length === 0) conversations.delete(key);
			else win.timestamps = recent;
		}
	}
	return {
		record(conversationKey) {
			cleanup();
			let win = conversations.get(conversationKey);
			if (!win) {
				win = { timestamps: [] };
				conversations.set(conversationKey, win);
			}
			win.timestamps.push(Date.now());
		},
		isRateLimited(conversationKey) {
			cleanup();
			const win = conversations.get(conversationKey);
			if (!win) return false;
			const now = Date.now();
			const recent = win.timestamps.filter((ts) => now - ts <= windowMs);
			win.timestamps = recent;
			return recent.length >= maxHits;
		}
	};
}
//#endregion
//#region extensions/imessage/src/monitor/strip-imsg-length-prefixed-text.ts
const utf8Decoder = new TextDecoder();
function readVarint(buf, start) {
	let offset = start;
	let value = 0;
	let shift = 0;
	while (offset < buf.length && shift <= 28) {
		const byte = buf[offset];
		offset += 1;
		value |= (byte & 127) << shift;
		if ((byte & 128) === 0) return {
			nextOffset: offset,
			value
		};
		shift += 7;
	}
	return null;
}
function tryStripImessageLengthPrefixedUtf8Buffer(buf) {
	const key = readVarint(buf, 0);
	if (!key || key.nextOffset >= buf.length) return null;
	if (key.value !== 10) return null;
	const length = readVarint(buf, key.nextOffset);
	if (!length || length.value === 0) return null;
	if (length.nextOffset + length.value !== buf.length) return null;
	return buf.subarray(length.nextOffset, buf.length);
}
function stripImessageLengthPrefixedUtf8Text(text) {
	if (!text) return text;
	const stripped = tryStripImessageLengthPrefixedUtf8Buffer(Buffer.from(text, "utf8"));
	if (!stripped) return text;
	const inner = utf8Decoder.decode(stripped);
	return inner.length > 0 ? inner : text;
}
//#endregion
//#region extensions/imessage/src/monitor/parse-notification.ts
function isOptionalString(value) {
	return value === void 0 || value === null || typeof value === "string";
}
function isOptionalStringOrNumber(value) {
	return value === void 0 || value === null || typeof value === "string" || typeof value === "number";
}
function isOptionalNumber(value) {
	return value === void 0 || value === null || typeof value === "number";
}
function isOptionalBoolean(value) {
	return value === void 0 || value === null || typeof value === "boolean";
}
function isOptionalStringArray(value) {
	return value === void 0 || value === null || Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function isOptionalAttachments(value) {
	if (value === void 0 || value === null) return true;
	if (!Array.isArray(value)) return false;
	return value.every((attachment) => {
		if (!isRecord(attachment)) return false;
		return isOptionalString(attachment.original_path) && isOptionalString(attachment.mime_type) && isOptionalBoolean(attachment.missing);
	});
}
function parseIMessageNotification(raw) {
	if (!isRecord(raw)) return null;
	const maybeMessage = raw.message;
	if (!isRecord(maybeMessage)) return null;
	const message = maybeMessage;
	if (!isOptionalNumber(message.id) || !isOptionalString(message.guid) || !isOptionalNumber(message.chat_id) || !isOptionalString(message.sender) || !isOptionalString(message.destination_caller_id) || !isOptionalBoolean(message.is_from_me) || !isOptionalString(message.text) || !isOptionalStringOrNumber(message.reply_to_id) || !isOptionalString(message.reply_to_text) || !isOptionalString(message.reply_to_sender) || !isOptionalString(message.created_at) || !isOptionalAttachments(message.attachments) || !isOptionalString(message.chat_identifier) || !isOptionalString(message.chat_guid) || !isOptionalString(message.chat_name) || !isOptionalStringArray(message.participants) || !isOptionalBoolean(message.is_group)) return null;
	return {
		...message,
		text: typeof message.text === "string" ? stripImessageLengthPrefixedUtf8Text(message.text) : message.text,
		reply_to_text: typeof message.reply_to_text === "string" ? stripImessageLengthPrefixedUtf8Text(message.reply_to_text) : message.reply_to_text
	};
}
//#endregion
//#region extensions/imessage/src/monitor/runtime.ts
function resolveRuntime(opts) {
	return opts.runtime ?? createNonExitingRuntime();
}
function normalizeAllowList(list) {
	return normalizeStringEntries(list);
}
//#endregion
//#region extensions/imessage/src/monitor/self-chat-cache.ts
const SELF_CHAT_TTL_MS = 1e4;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1e3;
function normalizeText(text) {
	if (!text) return null;
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	return normalized ? normalized : null;
}
function isUsableTimestamp(createdAt) {
	return typeof createdAt === "number" && Number.isFinite(createdAt);
}
function digestText(text) {
	return createHash("sha256").update(text).digest("hex");
}
function buildScope(parts) {
	if (!parts.isGroup) return `${parts.accountId}:imessage:${parts.sender}`;
	const chatTarget = formatIMessageChatTarget(parts.chatId) || "chat_id:unknown";
	return `${parts.accountId}:${chatTarget}:imessage:${parts.sender}`;
}
var DefaultSelfChatCache = class {
	constructor() {
		this.cache = /* @__PURE__ */ new Map();
		this.lastCleanupAt = 0;
	}
	buildKey(lookup) {
		const text = normalizeText(lookup.text);
		if (!text || !isUsableTimestamp(lookup.createdAt)) return null;
		return `${buildScope(lookup)}:${lookup.createdAt}:${digestText(text)}`;
	}
	remember(lookup) {
		const key = this.buildKey(lookup);
		if (!key) return;
		this.cache.set(key, Date.now());
		this.maybeCleanup();
	}
	has(lookup) {
		this.maybeCleanup();
		const key = this.buildKey(lookup);
		if (!key) return false;
		const timestamp = this.cache.get(key);
		return typeof timestamp === "number" && Date.now() - timestamp <= SELF_CHAT_TTL_MS;
	}
	maybeCleanup() {
		const now = Date.now();
		if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
		this.lastCleanupAt = now;
		for (const [key, timestamp] of this.cache.entries()) if (now - timestamp > SELF_CHAT_TTL_MS) this.cache.delete(key);
		while (this.cache.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
			const oldestKey = this.cache.keys().next().value;
			if (typeof oldestKey !== "string") break;
			this.cache.delete(oldestKey);
		}
	}
};
function createSelfChatCache() {
	return new DefaultSelfChatCache();
}
//#endregion
//#region extensions/imessage/src/monitor/watch-error-log.ts
const MAX_WATCH_ERROR_MESSAGE_CHARS = 200;
function sanitizeIMessageWatchErrorPayload(payload) {
	if (!isRecord(payload)) return {};
	const safe = {};
	if (typeof payload.code === "number" && Number.isFinite(payload.code)) safe.code = payload.code;
	if (typeof payload.message === "string") {
		const sanitizedMessage = sanitizeTerminalText(payload.message);
		if (sanitizedMessage) safe.message = sanitizedMessage.length > MAX_WATCH_ERROR_MESSAGE_CHARS ? `${truncateUtf16Safe(sanitizedMessage, MAX_WATCH_ERROR_MESSAGE_CHARS - 1)}…` : sanitizedMessage;
	}
	return safe;
}
//#endregion
//#region extensions/imessage/src/monitor/monitor-provider.ts
const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1e3;
/**
* Try to detect remote host from an SSH wrapper script like:
*   exec ssh -T openclaw@192.168.64.3 /opt/homebrew/bin/imsg "$@"
*   exec ssh -T mac-mini imsg "$@"
* Returns the user@host or host portion if found, undefined otherwise.
*/
async function detectRemoteHostFromCliPath(cliPath) {
	try {
		const expanded = cliPath.startsWith("~") ? cliPath.replace(/^~/, process.env.HOME ?? "") : cliPath;
		const content = await fs.readFile(expanded, "utf8");
		const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
		if (userHostMatch) return userHostMatch[1];
		return content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/)?.[1];
	} catch {
		return;
	}
}
function isRetriableWatchSubscribeStartupError(error) {
	return /imsg rpc timeout \(watch\.subscribe\)|imsg rpc (closed|exited|not running)/i.test(String(error));
}
async function waitForWatchSubscribeRetryDelay(params) {
	if (params.ms <= 0) return;
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			params.abortSignal?.removeEventListener("abort", onAbort);
			resolve();
		}, params.ms);
		const onAbort = () => {
			clearTimeout(timer);
			params.abortSignal?.removeEventListener("abort", onAbort);
			resolve();
		};
		params.abortSignal?.addEventListener("abort", onAbort, { once: true });
	});
}
async function monitorIMessageProvider(opts = {}) {
	const runtime = resolveRuntime(opts);
	const cfg = opts.config ?? getRuntimeConfig();
	const accountInfo = resolveIMessageAccount({
		cfg,
		accountId: opts.accountId
	});
	const imessageCfg = accountInfo.config;
	const historyLimit = Math.max(0, imessageCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50);
	const groupHistories = /* @__PURE__ */ new Map();
	const sentMessageCache = createSentMessageCache();
	const selfChatCache = createSelfChatCache();
	const loopRateLimiter = createLoopRateLimiter();
	const textLimit = resolveTextChunkLimit(cfg, "imessage", accountInfo.accountId);
	const allowFrom = normalizeAllowList(opts.allowFrom ?? imessageCfg.allowFrom);
	const groupAllowFrom = normalizeAllowList(opts.groupAllowFrom ?? imessageCfg.groupAllowFrom ?? (imessageCfg.allowFrom && imessageCfg.allowFrom.length > 0 ? imessageCfg.allowFrom : []));
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.imessage !== void 0,
		groupPolicy: imessageCfg.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "imessage",
		accountId: accountInfo.accountId,
		log: (message) => runtime.log?.(warn(message))
	});
	const dmPolicy = imessageCfg.dmPolicy ?? "pairing";
	const includeAttachments = opts.includeAttachments ?? imessageCfg.includeAttachments ?? false;
	const mediaMaxBytes = (opts.mediaMaxMb ?? imessageCfg.mediaMaxMb ?? 16) * 1024 * 1024;
	const cliPath = opts.cliPath ?? imessageCfg.cliPath ?? "imsg";
	const dbPath = opts.dbPath ?? imessageCfg.dbPath;
	const probeTimeoutMs = imessageCfg.probeTimeoutMs ?? 1e4;
	const attachmentRoots = resolveIMessageAttachmentRoots({
		cfg,
		accountId: accountInfo.accountId
	});
	const remoteAttachmentRoots = resolveIMessageRemoteAttachmentRoots({
		cfg,
		accountId: accountInfo.accountId
	});
	const configuredRemoteHost = normalizeScpRemoteHost(imessageCfg.remoteHost);
	if (imessageCfg.remoteHost && !configuredRemoteHost) logVerbose("imessage: ignoring unsafe channels.imessage.remoteHost value");
	let remoteHost = configuredRemoteHost;
	if (!remoteHost && cliPath && cliPath !== "imsg") {
		const detected = await detectRemoteHostFromCliPath(cliPath);
		const normalizedDetected = normalizeScpRemoteHost(detected);
		if (detected && !normalizedDetected) logVerbose("imessage: ignoring unsafe auto-detected remoteHost from cliPath");
		remoteHost = normalizedDetected;
		if (remoteHost) logVerbose(`imessage: detected remoteHost=${remoteHost} from cliPath`);
	}
	const { debouncer: inboundDebouncer } = createChannelInboundDebouncer({
		cfg,
		channel: "imessage",
		buildKey: (entry) => {
			const sender = entry.message.sender?.trim();
			if (!sender) return null;
			const conversationId = entry.message.chat_id != null ? `chat:${entry.message.chat_id}` : entry.message.chat_guid ?? entry.message.chat_identifier ?? "unknown";
			return `imessage:${accountInfo.accountId}:${conversationId}:${sender}`;
		},
		shouldDebounce: (entry) => {
			return shouldDebounceTextInbound({
				text: entry.message.text,
				cfg,
				hasMedia: Boolean(entry.message.attachments && entry.message.attachments.length > 0)
			});
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			if (entries.length === 1) {
				await handleMessageNow(last.message);
				return;
			}
			const combinedText = entries.map((entry) => entry.message.text ?? "").filter(Boolean).join("\n");
			await handleMessageNow({
				...last.message,
				text: combinedText,
				attachments: null
			});
		},
		onError: (err) => {
			runtime.error?.(`imessage debounce flush failed: ${String(err)}`);
		}
	});
	let client;
	let detachAbortHandler = () => {};
	const getActiveClient = () => {
		if (!client) throw new Error("imessage monitor client not initialized");
		return client;
	};
	async function handleMessageNow(message) {
		const messageText = (message.text ?? "").trim();
		const attachments = includeAttachments ? message.attachments ?? [] : [];
		const effectiveAttachmentRoots = remoteHost ? remoteAttachmentRoots : attachmentRoots;
		const validAttachments = attachments.filter((entry) => {
			const attachmentPath = entry?.original_path?.trim();
			if (!attachmentPath || entry?.missing) return false;
			if (isInboundPathAllowed({
				filePath: attachmentPath,
				roots: effectiveAttachmentRoots
			})) return true;
			logVerbose(`imessage: dropping inbound attachment outside allowed roots: ${attachmentPath}`);
			return false;
		});
		const firstAttachment = validAttachments[0];
		const mediaPath = firstAttachment?.original_path ?? void 0;
		const mediaType = firstAttachment?.mime_type ?? void 0;
		const mediaPaths = validAttachments.map((a) => a.original_path).filter(Boolean);
		const mediaTypes = validAttachments.map((a) => a.mime_type ?? void 0);
		const kind = kindFromMime(mediaType ?? void 0);
		const placeholder = kind ? `<media:${kind}>` : validAttachments.length ? "<media:attachment>" : "";
		const bodyText = messageText || placeholder;
		const storeAllowFrom = await readChannelAllowFromStore("imessage", process.env, accountInfo.accountId).catch(() => []);
		const decision = resolveIMessageInboundDecision({
			cfg,
			accountId: accountInfo.accountId,
			message,
			opts,
			messageText,
			bodyText,
			allowFrom,
			groupAllowFrom,
			groupPolicy,
			dmPolicy,
			storeAllowFrom,
			historyLimit,
			groupHistories,
			echoCache: sentMessageCache,
			selfChatCache,
			logVerbose
		});
		const chatId = message.chat_id ?? void 0;
		const senderForKey = (message.sender ?? "").trim();
		const conversationKey = chatId != null ? `group:${chatId}` : `dm:${senderForKey}`;
		const rateLimitKey = `${accountInfo.accountId}:${conversationKey}`;
		if (decision.kind === "drop") {
			if (decision.reason === "echo" || decision.reason === "self-chat echo" || decision.reason === "reflected assistant content" || decision.reason === "from me") loopRateLimiter.record(rateLimitKey);
			return;
		}
		if (decision.kind === "dispatch" && loopRateLimiter.isRateLimited(rateLimitKey)) {
			logVerbose(`imessage: rate-limited conversation ${conversationKey} (echo loop detected)`);
			return;
		}
		if (decision.kind === "pairing") {
			const sender = (message.sender ?? "").trim();
			if (!sender) return;
			await createChannelPairingChallengeIssuer({
				channel: "imessage",
				upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
					channel: "imessage",
					id,
					accountId: accountInfo.accountId,
					meta
				})
			})({
				senderId: decision.senderId,
				senderIdLine: `Your iMessage sender id: ${decision.senderId}`,
				meta: {
					sender: decision.senderId,
					chatId: chatId ? String(chatId) : void 0
				},
				onCreated: () => {
					logVerbose(`imessage pairing request sender=${decision.senderId}`);
				},
				sendPairingReply: async (text) => {
					await sendMessageIMessage(sender, text, {
						config: cfg,
						client: getActiveClient(),
						maxBytes: mediaMaxBytes,
						accountId: accountInfo.accountId,
						...chatId ? { chatId } : {}
					});
				},
				onReplyError: (err) => {
					logVerbose(`imessage pairing reply failed for ${decision.senderId}: ${String(err)}`);
				}
			});
			return;
		}
		const storePath = resolveStorePath(cfg.session?.store, { agentId: decision.route.agentId });
		const { ctxPayload, chatTarget } = buildIMessageInboundContext({
			cfg,
			decision,
			message,
			previousTimestamp: readSessionUpdatedAt({
				storePath,
				sessionKey: decision.route.sessionKey
			}),
			remoteHost,
			historyLimit,
			groupHistories,
			media: {
				path: mediaPath,
				type: mediaType,
				paths: mediaPaths,
				types: mediaTypes
			}
		});
		const updateTarget = chatTarget || decision.sender;
		const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
			dmScope: cfg.session?.dmScope,
			allowFrom,
			normalizeEntry: normalizeIMessageHandle
		});
		if (shouldLogVerbose()) {
			const preview = truncateUtf16Safe(ctxPayload.Body ?? "", 200).replace(/\n/g, "\\n");
			logVerbose(`imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${(ctxPayload.Body ?? "").length} preview="${preview}"`);
		}
		const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
			cfg,
			agentId: decision.route.agentId,
			channel: "imessage",
			accountId: decision.route.accountId
		});
		const dispatcher = createReplyDispatcher({
			...replyPipeline,
			humanDelay: resolveHumanDelayConfig(cfg, decision.route.agentId),
			deliver: async (payload) => {
				const target = ctxPayload.To;
				if (!target) {
					runtime.error?.(danger("imessage: missing delivery target"));
					return;
				}
				await deliverReplies({
					cfg,
					replies: [payload],
					target,
					client: getActiveClient(),
					accountId: accountInfo.accountId,
					runtime,
					maxBytes: mediaMaxBytes,
					textLimit,
					sentMessageCache
				});
			},
			onError: (err, info) => {
				runtime.error?.(danger(`imessage ${info.kind} reply failed: ${String(err)}`));
			}
		});
		await runInboundReplyTurn({
			channel: "imessage",
			accountId: decision.route.accountId,
			raw: decision,
			adapter: {
				ingest: () => ({
					id: ctxPayload.MessageSid ?? `${ctxPayload.From}:${Date.now()}`,
					timestamp: typeof ctxPayload.Timestamp === "number" ? ctxPayload.Timestamp : void 0,
					rawText: ctxPayload.RawBody ?? "",
					textForAgent: ctxPayload.BodyForAgent,
					textForCommands: ctxPayload.CommandBody,
					raw: decision
				}),
				resolveTurn: () => ({
					channel: "imessage",
					accountId: decision.route.accountId,
					routeSessionKey: decision.route.sessionKey,
					storePath,
					ctxPayload,
					recordInboundSession,
					record: {
						updateLastRoute: !decision.isGroup && updateTarget ? {
							sessionKey: decision.route.mainSessionKey,
							channel: "imessage",
							to: updateTarget,
							accountId: decision.route.accountId,
							mainDmOwnerPin: pinnedMainDmOwner && decision.senderNormalized ? {
								ownerRecipient: pinnedMainDmOwner,
								senderRecipient: decision.senderNormalized,
								onSkip: ({ ownerRecipient, senderRecipient }) => {
									logVerbose(`imessage: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
								}
							} : void 0
						} : void 0,
						onRecordError: (err) => {
							logVerbose(`imessage: failed updating session meta: ${String(err)}`);
						}
					},
					history: {
						isGroup: decision.isGroup,
						historyKey: decision.historyKey,
						historyMap: groupHistories,
						limit: historyLimit
					},
					onPreDispatchFailure: () => settleReplyDispatcher({ dispatcher }),
					runDispatch: () => dispatchInboundMessage({
						ctx: ctxPayload,
						cfg,
						dispatcher,
						replyOptions: {
							disableBlockStreaming: typeof accountInfo.config.blockStreaming === "boolean" ? !accountInfo.config.blockStreaming : void 0,
							onModelSelected
						}
					})
				})
			}
		});
	}
	const handleMessage = async (raw) => {
		const message = parseIMessageNotification(raw);
		if (!message) {
			logVerbose("imessage: dropping malformed RPC message payload");
			return;
		}
		await inboundDebouncer.enqueue({ message });
	};
	await waitForTransportReady({
		label: "imsg rpc",
		timeoutMs: 3e4,
		logAfterMs: 1e4,
		logIntervalMs: 1e4,
		pollIntervalMs: 500,
		abortSignal: opts.abortSignal,
		runtime,
		check: async () => {
			const probe = await probeIMessage(probeTimeoutMs, {
				cliPath,
				dbPath,
				runtime
			});
			if (probe.ok) return { ok: true };
			if (probe.fatal) throw new Error(probe.error ?? "imsg rpc unavailable");
			return {
				ok: false,
				error: probe.error ?? "unreachable"
			};
		}
	});
	if (opts.abortSignal?.aborted) return;
	const abort = opts.abortSignal;
	const createWatchClient = async () => await createIMessageRpcClient({
		cliPath,
		dbPath,
		runtime,
		onNotification: (msg) => {
			if (msg.method === "message") handleMessage(msg.params).catch((err) => {
				runtime.error?.(`imessage: handler failed: ${String(err)}`);
			});
			else if (msg.method === "error") runtime.error?.(`imessage: watch error ${JSON.stringify(sanitizeIMessageWatchErrorPayload(msg.params))}`);
		}
	});
	const requireWatchClient = (watchClient) => {
		if (!watchClient) throw new Error("imessage monitor client not initialized");
		return watchClient;
	};
	for (let attempt = 1; attempt <= WATCH_SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
		if (abort?.aborted) return;
		let attemptClient;
		let attemptDetachAbortHandler = () => {};
		let keepAttemptClient = false;
		try {
			attemptClient = requireWatchClient(await createWatchClient());
			let attemptSubscriptionId = null;
			attemptDetachAbortHandler = attachIMessageMonitorAbortHandler({
				abortSignal: abort,
				client: attemptClient,
				getSubscriptionId: () => attemptSubscriptionId
			});
			attemptSubscriptionId = (await attemptClient.request("watch.subscribe", { attachments: includeAttachments }, { timeoutMs: probeTimeoutMs }))?.subscription ?? null;
			client = attemptClient;
			detachAbortHandler = attemptDetachAbortHandler;
			keepAttemptClient = true;
			break;
		} catch (err) {
			if (abort?.aborted) return;
			if (!(attempt < WATCH_SUBSCRIBE_MAX_ATTEMPTS && isRetriableWatchSubscribeStartupError(err))) {
				runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
				throw err;
			}
			runtime.log?.(warn(`imessage: watch.subscribe startup failed (attempt ${attempt}/${WATCH_SUBSCRIBE_MAX_ATTEMPTS}): ${String(err)}; retrying`));
			attemptDetachAbortHandler();
			attemptDetachAbortHandler = () => {};
			await attemptClient?.stop();
			attemptClient = void 0;
			await waitForWatchSubscribeRetryDelay({
				ms: WATCH_SUBSCRIBE_RETRY_DELAY_MS,
				abortSignal: abort
			});
			if (abort?.aborted) return;
		} finally {
			if (!keepAttemptClient) {
				attemptDetachAbortHandler();
				await attemptClient?.stop();
			}
		}
	}
	const activeClient = client;
	if (!activeClient) return;
	try {
		await activeClient.waitForClose();
	} catch (err) {
		if (abort?.aborted) return;
		runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
		throw err;
	} finally {
		detachAbortHandler();
		await activeClient.stop();
	}
}
//#endregion
export { sendMessageIMessage as n, monitorIMessageProvider as t };
