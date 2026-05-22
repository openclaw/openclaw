import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { d as registerUnhandledRejectionHandler } from "./unhandled-rejections-BKIyIiWA.js";
import { l as normalizeE164 } from "./utils-CRkrr5e6.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-9_btbLFO.js";
import { a as buildGroupHistoryKey, c as normalizeAgentId$1, f as resolveThreadSessionKeys, n as DEFAULT_MAIN_KEY, r as buildAgentMainSessionKey } from "./session-key-8g_Q03Po.js";
import { n as defaultRuntime } from "./runtime-Bd9_VI2J.js";
import { i as getChildLogger } from "./logger-DlBx5AyB.js";
import { a as shouldLogVerbose, r as logVerbose, s as warn } from "./globals-2rjcRy6M.js";
import { t as createSubsystemLogger } from "./subsystem-DtPhzVBn.js";
import { i as getRuntimeConfig } from "./io-BTdvKaBm.js";
import { s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-BZYZ5rKR.js";
import { t as resolveAccountEntry } from "./account-lookup-DV8jWW5k.js";
import { l as fireAndForgetBoundedHook, t as getGlobalHookRunner } from "./hook-runner-global-DXf4X1LM.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-Dmrw37Ld.js";
import { u as resolveStorePath } from "./paths-D2tVOYHR.js";
import { t as loadSessionStore } from "./store-load-6WUUNuxk.js";
import { o as updateLastRoute, s as updateSessionStore } from "./store-DOk7wSx2.js";
import { n as sleepWithAbort, t as computeBackoff } from "./backoff-1wqGgkrR.js";
import { a as enqueueSystemEvent } from "./system-events-k1OmfILA.js";
import { g as sendMediaWithLeadingCaption, m as resolveSendableOutboundReplyParts, u as isReasoningReplyPayload } from "./reply-payload-BnEJNs4t.js";
import { r as formatDurationPrecise } from "./format-duration-CImOQ7n-.js";
import { u as saveMediaBuffer } from "./store-BKnXsQdq.js";
import { r as getAgentScopedMediaLocalRoots } from "./local-roots-Cba21kyM.js";
import { t as loadWebMedia } from "./web-media-B-f-ncAU.js";
import { c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, s as resolveChunkMode } from "./chunk-Cwj1J7Kz.js";
import { i as toInternalMessageReceivedContext, l as toPluginMessageContext, n as deriveInboundMessageHookContext, u as toPluginMessageReceivedEvent } from "./message-hook-mappers-C3pOu72T.js";
import { n as resolveBatchedReplyThreadingPolicy } from "./reply-threading-Cr22gDee.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-D4thzls4.js";
import { a as resolveInboundLastRouteSessionKey, i as resolveAgentRoute, n as deriveLastRoutePolicy, t as buildAgentSessionKey } from "./resolve-route-Wl2GLQR8.js";
import { a as resolveIdentityNamePrefix$1 } from "./identity-BHO4vaI4.js";
import { a as normalizeMentionText, n as buildMentionRegexes } from "./mentions-DSuVxhvh.js";
import { t as finalizeInboundContext } from "./inbound-context-PrYNGmXv.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-3rtWChjA.js";
import "./string-coerce-runtime-B-Wo_S-q.js";
import "./account-core-DQL1Bczt.js";
import "./routing-vUUo8AvK.js";
import { i as shouldComputeCommandAuthorized, t as hasControlCommand } from "./command-detection-C_YGtBnK.js";
import { r as formatInboundEnvelope } from "./envelope-Wzq3Phnk.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-C3qgvRRJ.js";
import { a as shouldAckReactionForWhatsApp, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "./ack-reactions-Cz2IryHq.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-DFxiuzHe.js";
import { t as recordInboundSession } from "./session-wVd8d2m3.js";
import { d as recordPendingHistoryEntryIfEnabled, i as buildHistoryContextFromEntries } from "./history-CdYu8rTH.js";
import { n as resolveChannelSourceReplyDeliveryMode, t as createChannelReplyPipeline } from "./reply-pipeline-BqCCw347.js";
import { r as hasVisibleChannelTurnDispatch } from "./dispatch-result-Ciss2W_e.js";
import { n as filterSupplementalContextItems, t as evaluateSupplementalContextVisibility } from "./context-visibility-BiYy5rak.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-0ejdDg51.js";
import { n as recordChannelActivity } from "./channel-activity-B22YB5W0.js";
import { t as convertMarkdownTables } from "./tables-Nh1Yv6rJ.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist } from "./channel-access-compat-CramsYVg.js";
import "./reply-history-CjdFtFnt.js";
import "./runtime-env-zJY-klAY.js";
import { t as resolveChannelContextVisibilityMode } from "./context-visibility-DJLGLY3W.js";
import { n as parseActivationCommand, t as normalizeGroupActivation } from "./group-activation-BcW3827b.js";
import "./reply-runtime-D-jOtVgQ.js";
import "./reply-reference-BlO_udOJ.js";
import "./reply-chunking-DxLzKfea.js";
import { d as runInboundReplyTurn } from "./inbound-reply-dispatch-CAvZUxTt.js";
import "./web-media-DTDebQZn.js";
import { t as drainPendingDeliveries } from "./delivery-queue-runtime-Cu1UgINV.js";
import "./system-event-runtime-DEAN5Rs9.js";
import "./runtime-config-snapshot-B4v9ZtDh.js";
import "./media-runtime-CiCyW7ch.js";
import "./media-store-BjcEcXgj.js";
import "./conversation-runtime-C2WrEv1U.js";
import "./agent-runtime-DQpj87aw.js";
import "./plugin-runtime-CXY7gvGV.js";
import "./security-runtime-DC0_5_-H.js";
import { n as createTransportActivityStatusPatch, t as createConnectedChannelStatusPatch } from "./gateway-runtime-B5boVxyH.js";
import "./cli-runtime-DTrS0X3P.js";
import "./hook-runtime-ByxGBGE1.js";
import "./channel-mention-gating-By2jH3cV.js";
import "./logging-core-CDrxPx6a.js";
import "./markdown-table-runtime-BhMFjYsS.js";
import "./command-detection-DvXLLZ7r.js";
import { t as logAckFailure } from "./logging-BFacwzHQ.js";
import "./channel-feedback-D-0drMkb.js";
import { t as resolveInboundSessionEnvelopeContext } from "./channel-inbound-CknlNatI.js";
import { n as toLocationContext, t as formatLocationText } from "./location-KXRARpTH.js";
import { a as deliverInboundReplyWithMessageSendContext } from "./channel-message-CBzgQfUC.js";
import "./session-store-runtime-Cl0uIHKF.js";
import { t as createClaimableDedupe } from "./persistent-dedupe-Ir_F9Gdb.js";
import { a as resolveWhatsAppAccount, s as resolveWhatsAppMediaMaxBytes } from "./accounts-DyY9IjH9.js";
import { t as isWhatsAppGroupJid } from "./normalize-target-Dzyko5kl.js";
import { t as resolveWhatsAppReactionLevel } from "./reaction-level-D1wOsvie.js";
import { n as getStatusCode, t as formatError } from "./session-errors-CuAR5lAV.js";
import { a as resolveJidToE164, i as markdownToWhatsApp, n as isSelfChatMode, r as jidToE164 } from "./text-runtime-6sdl2e11.js";
import { i as prepareWhatsAppOutboundMedia, o as sendWhatsAppOutboundWithRetry, r as normalizeWhatsAppPayloadTextPreservingIndentation, t as normalizeWhatsAppOutboundPayload } from "./outbound-media-contract-050LP-cU.js";
import { r as sendReactionWhatsApp } from "./send-HfsQSDaZ.js";
import { n as cacheInboundMessageMeta, r as lookupInboundMessageMeta, t as buildQuotedMessageOptions } from "./quoted-message-BHLxto4r.js";
import { _ as readWebSelfIdentityForDecision, a as getWebAuthAgeMs, h as readWebSelfId, r as WhatsAppAuthUnstableError, s as logoutWeb } from "./auth-store-fIu0IuAh.js";
import { a as getSelfIdentity, c as resolveComparableIdentity, i as getReplyContext, n as getMentionIdentities, o as getSenderIdentity, r as getPrimaryIdentityId, s as identitiesOverlap, t as getComparableIdentityValues } from "./identity-N--G5NF8.js";
import { i as resolveWhatsAppInboundPolicy, n as checkInboundAccessControl, r as resolveWhatsAppCommandAuthorized } from "./access-control-ChlAjpLb.js";
import { d as DisconnectReason, i as downloadMediaMessage, s as normalizeMessageContent, u as isJidGroup } from "./session.runtime-DWbLnKUJ.js";
import { a as mayContainWhatsAppOutboundMention, c as extractContactContext, d as extractMediaPlaceholder, f as extractMentionedJids, i as addWhatsAppOutboundMentionsToContent, l as extractContextInfo, m as hasInboundUserContent, n as listWhatsAppSendResultMessageIds, o as resolveWhatsAppOutboundMentions, p as extractText, r as normalizeWhatsAppSendResult, s as describeReplyContext, t as createWebSendApi, u as extractLocationData } from "./send-api-D8uIdU3-.js";
import { i as resolveWhatsAppSocketTiming, r as waitForWaConnection, t as createWaSocket } from "./session-BZ5-28Sc.js";
import { c as newConnectionId, l as resolveHeartbeatSeconds, n as WHATSAPP_WATCHDOG_TIMEOUT_ERROR, r as WhatsAppConnectionController, s as DEFAULT_RECONNECT_POLICY, u as resolveReconnectPolicy } from "./connection-controller-C2Vd9n51.js";
//#region extensions/whatsapp/src/inbound/dedupe.ts
const RECENT_WEB_MESSAGE_TTL_MS = 20 * 6e4;
const RECENT_WEB_MESSAGE_MAX = 5e3;
const RECENT_OUTBOUND_MESSAGE_TTL_MS = 20 * 6e4;
const RECENT_OUTBOUND_MESSAGE_MAX = 5e3;
const claimableInboundMessages = createClaimableDedupe({
	ttlMs: RECENT_WEB_MESSAGE_TTL_MS,
	memoryMaxSize: RECENT_WEB_MESSAGE_MAX
});
const recentOutboundMessages = createRecentMessageCache({
	ttlMs: RECENT_OUTBOUND_MESSAGE_TTL_MS,
	maxSize: RECENT_OUTBOUND_MESSAGE_MAX
});
function createRecentMessageCache(options) {
	const ttlMs = Math.max(0, options.ttlMs);
	const maxSize = Math.max(0, Math.floor(options.maxSize));
	const cache = /* @__PURE__ */ new Map();
	const prune = (now) => {
		if (ttlMs > 0) {
			const cutoff = now - ttlMs;
			for (const [key, timestamp] of cache) if (timestamp < cutoff) cache.delete(key);
		}
		while (cache.size > maxSize) {
			const oldest = cache.keys().next().value;
			if (!oldest) break;
			cache.delete(oldest);
		}
	};
	const peek = (key, now = Date.now()) => {
		if (!key) return false;
		const timestamp = cache.get(key);
		if (timestamp === void 0) return false;
		if (ttlMs > 0 && now - timestamp >= ttlMs) {
			cache.delete(key);
			return false;
		}
		return true;
	};
	return {
		check: (key, now = Date.now()) => {
			if (!key) return false;
			const existed = peek(key, now);
			cache.delete(key);
			cache.set(key, now);
			prune(now);
			return existed;
		},
		peek,
		clear: () => cache.clear()
	};
}
var WhatsAppRetryableInboundError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "WhatsAppRetryableInboundError";
	}
};
function buildMessageKey(params) {
	const accountId = params.accountId.trim();
	const remoteJid = params.remoteJid.trim();
	const messageId = params.messageId.trim();
	if (!accountId || !remoteJid || !messageId || messageId === "unknown") return null;
	return `${accountId}:${remoteJid}:${messageId}`;
}
function resetWebInboundDedupe() {
	claimableInboundMessages.clearMemory();
	recentOutboundMessages.clear();
}
async function claimRecentInboundMessage(key) {
	return (await claimableInboundMessages.claim(key)).kind === "claimed";
}
async function commitRecentInboundMessage(key) {
	await claimableInboundMessages.commit(key);
}
function releaseRecentInboundMessage(key, error) {
	claimableInboundMessages.release(key, { error });
}
function rememberRecentOutboundMessage(params) {
	const key = buildMessageKey(params);
	if (!key) return;
	recentOutboundMessages.check(key);
}
function isRecentOutboundMessage(params) {
	const key = buildMessageKey(params);
	if (!key) return false;
	return recentOutboundMessages.peek(key);
}
//#endregion
//#region extensions/whatsapp/src/inbound/lifecycle.ts
function attachEmitterListener(emitter, event, listener) {
	emitter.on(event, listener);
	return () => {
		if (typeof emitter.off === "function") {
			emitter.off(event, listener);
			return;
		}
		if (typeof emitter.removeListener === "function") emitter.removeListener(event, listener);
	};
}
function closeInboundMonitorSocket(sock) {
	if (typeof sock.end === "function") {
		sock.end(/* @__PURE__ */ new Error("OpenClaw WhatsApp listener close"));
		return;
	}
	sock.ws?.close?.();
}
//#endregion
//#region extensions/whatsapp/src/inbound/media.ts
function unwrapMessage(message) {
	return normalizeMessageContent(message);
}
/**
* Resolve the MIME type for an inbound media message.
* Falls back to WhatsApp's standard formats when Baileys omits the MIME.
*/
function resolveMediaMimetype(message) {
	const explicit = message.imageMessage?.mimetype ?? message.videoMessage?.mimetype ?? message.documentMessage?.mimetype ?? message.audioMessage?.mimetype ?? message.stickerMessage?.mimetype ?? void 0;
	if (explicit) return explicit;
	if (message.audioMessage) return "audio/ogg; codecs=opus";
	if (message.imageMessage) return "image/jpeg";
	if (message.videoMessage) return "video/mp4";
	if (message.stickerMessage) return "image/webp";
}
async function downloadInboundMedia(msg, sock) {
	const message = unwrapMessage(msg.message);
	if (!message) return;
	const mimetype = resolveMediaMimetype(message);
	const fileName = message.documentMessage?.fileName ?? void 0;
	if (!message.imageMessage && !message.videoMessage && !message.documentMessage && !message.audioMessage && !message.stickerMessage) return;
	try {
		return {
			buffer: await downloadMediaMessage(msg, "buffer", {}, {
				reuploadRequest: sock.updateMediaMessage,
				logger: sock.logger
			}),
			mimetype,
			fileName
		};
	} catch (err) {
		logVerbose(`downloadMediaMessage failed: ${String(err)}`);
		return;
	}
}
async function downloadQuotedInboundMedia(msg, sock) {
	const contextInfo = extractContextInfo(unwrapMessage(msg.message));
	if (!contextInfo?.quotedMessage) return;
	const quotedMessage = contextInfo.quotedMessage;
	return downloadInboundMedia({
		key: {
			id: contextInfo?.stanzaId || void 0,
			remoteJid: contextInfo.remoteJid ?? msg.key?.remoteJid ?? void 0,
			participant: contextInfo?.participant ?? void 0,
			fromMe: false
		},
		message: quotedMessage,
		messageTimestamp: msg.messageTimestamp
	}, sock);
}
//#endregion
//#region extensions/whatsapp/src/inbound/monitor.ts
const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";
const GROUP_META_TTL_MS = 300 * 1e3;
function rememberGroupMetadataCacheEntry(cache, jid, entry) {
	if (cache.has(jid)) cache.delete(jid);
	cache.set(jid, entry);
	while (cache.size > 500) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}
function readGroupMetadataCacheEntry(cache, jid) {
	const entry = cache.get(jid);
	if (!entry) return null;
	if (entry.expires <= Date.now()) {
		cache.delete(jid);
		return null;
	}
	cache.delete(jid);
	cache.set(jid, entry);
	return entry;
}
function logWhatsAppVerbose(enabled, message) {
	if (!enabled) return;
	defaultRuntime.log(message);
}
function isGroupJid(jid) {
	return (typeof isJidGroup === "function" ? isJidGroup(jid) : jid.endsWith("@g.us")) === true;
}
function recordAcceptedInboundActivity(accountId) {
	recordChannelActivity({
		channel: "whatsapp",
		accountId,
		direction: "inbound"
	});
}
function isRetryableSendDisconnectError(err) {
	return /closed|reset|timed\s*out|disconnect|no active socket/i.test(formatError(err));
}
function shouldClearSocketRefAfterSendFailure(err) {
	return /closed|reset|disconnect|no active socket/i.test(formatError(err));
}
function isNonEmptyString(value) {
	return Boolean(value);
}
async function attachWebInboxToSocket(options) {
	const inboundLogger = getChildLogger({ module: "web-inbound" });
	const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
	const sock = options.sock;
	const connectedAtMs = Date.now();
	if (options.socketRef) options.socketRef.current = sock;
	const getCurrentSock = () => options.socketRef ? options.socketRef.current : sock;
	const shouldRetryDisconnect = () => options.shouldRetryDisconnect?.() === true;
	const disconnectRetryPolicy = options.disconnectRetryPolicy ?? DEFAULT_RECONNECT_POLICY;
	const sendRetryMaxAttempts = disconnectRetryPolicy.maxAttempts > 0 ? disconnectRetryPolicy.maxAttempts : DEFAULT_RECONNECT_POLICY.maxAttempts;
	let onCloseResolve = null;
	const onClose = new Promise((resolve) => {
		onCloseResolve = resolve;
	});
	const resolveClose = (reason) => {
		if (!onCloseResolve) return;
		const resolver = onCloseResolve;
		onCloseResolve = null;
		resolver(reason);
	};
	const presence = options.selfChatMode ? "unavailable" : "available";
	try {
		await sock.sendPresenceUpdate(presence);
		logWhatsAppVerbose(options.verbose, `Sent global '${presence}' presence on connect`);
	} catch (err) {
		logWhatsAppVerbose(options.verbose, `Failed to send '${presence}' presence on connect: ${String(err)}`);
	}
	const selfIdentity = await readWebSelfIdentityForDecision(options.authDir, sock.user);
	if (selfIdentity.outcome === "unstable") throw new WhatsAppAuthUnstableError("WhatsApp auth state is still stabilizing; retrying inbox attach.");
	const self = selfIdentity.identity;
	const finalizeInboundDedupe = async (entries, error) => {
		const dedupeKeys = [...new Set(entries.map((entry) => entry.dedupeKey).filter(isNonEmptyString))];
		if (dedupeKeys.length === 0) return;
		if (error instanceof WhatsAppRetryableInboundError) {
			dedupeKeys.forEach((dedupeKey) => releaseRecentInboundMessage(dedupeKey, error));
			return;
		}
		await Promise.all(dedupeKeys.map((dedupeKey) => commitRecentInboundMessage(dedupeKey)));
	};
	const debouncer = createInboundDebouncer({
		debounceMs: options.debounceMs ?? 0,
		buildKey: (msg) => {
			const sender = msg.sender;
			const senderKey = msg.chatType === "group" ? getPrimaryIdentityId(sender ?? null) ?? msg.senderJid ?? msg.senderE164 ?? msg.senderName ?? msg.from : msg.from;
			if (!senderKey) return null;
			const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
			return `${msg.accountId}:${conversationKey}:${senderKey}`;
		},
		shouldDebounce: options.shouldDebounce,
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			try {
				if (entries.length === 1) {
					await options.onMessage(last);
					await finalizeInboundDedupe(entries);
					return;
				}
				const mentioned = /* @__PURE__ */ new Set();
				for (const entry of entries) for (const jid of entry.mentions ?? entry.mentionedJids ?? []) mentioned.add(jid);
				const combinedBody = entries.map((entry) => entry.body).filter(Boolean).join("\n");
				const combinedMessage = {
					...last,
					body: combinedBody,
					mentions: mentioned.size > 0 ? Array.from(mentioned) : void 0,
					mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : void 0,
					isBatched: true
				};
				await options.onMessage(combinedMessage);
				await finalizeInboundDedupe(entries);
			} catch (error) {
				await finalizeInboundDedupe(entries, error);
				throw error;
			}
		},
		onError: (err) => {
			inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
			inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
		}
	});
	const groupMetadataCache = options.groupMetadataCache ?? /* @__PURE__ */ new Map();
	const groupMetaCache = /* @__PURE__ */ new Map();
	const lidLookup = sock.signalRepository?.lidMapping;
	const resolveInboundJid = async (jid) => resolveJidToE164(jid, {
		authDir: options.authDir,
		lidLookup
	});
	const rememberOutboundMessage = (remoteJid, result) => {
		const messageId = typeof result === "object" && result && "key" in result ? result.key?.id ?? "" : "";
		if (!messageId) return;
		rememberRecentOutboundMessage({
			accountId: options.accountId,
			remoteJid,
			messageId
		});
	};
	const sendTrackedMessage = async (jid, content, sendOptions) => {
		let lastErr = new Error(RECONNECT_IN_PROGRESS_ERROR);
		for (let attempt = 1;; attempt++) {
			const currentSock = getCurrentSock();
			if (currentSock) try {
				const result = sendOptions ? await currentSock.sendMessage(jid, content, sendOptions) : await currentSock.sendMessage(jid, content);
				rememberOutboundMessage(jid, result);
				return result;
			} catch (err) {
				if (!shouldRetryDisconnect() || !isRetryableSendDisconnectError(err)) throw err;
				lastErr = err;
				if (shouldClearSocketRefAfterSendFailure(err) && options.socketRef?.current === currentSock) options.socketRef.current = null;
			}
			else if (!shouldRetryDisconnect()) throw lastErr;
			if (attempt >= sendRetryMaxAttempts) throw lastErr;
			const delayMs = computeBackoff(disconnectRetryPolicy, attempt);
			logWhatsAppVerbose(options.verbose, `Waiting ${delayMs}ms for WhatsApp reconnect before retrying send to ${jid}: ${formatError(lastErr)}`);
			try {
				await sleepWithAbort(delayMs, options.disconnectRetryAbortSignal);
			} catch {
				throw lastErr;
			}
		}
	};
	const summarizeGroupMeta = async (meta) => {
		const participantEntries = await Promise.all(meta.participants?.map(async (p) => {
			const mapped = await resolveInboundJid(p.id);
			return {
				display: mapped ?? p.id,
				mention: {
					id: p.id,
					lid: p.lid,
					phoneNumber: p.phoneNumber,
					e164: mapped
				}
			};
		}) ?? []);
		const participants = participantEntries.map((entry) => entry.display).filter(Boolean);
		const mentionParticipants = participantEntries.map((entry) => entry.mention);
		return {
			subject: meta.subject,
			participants,
			mentionParticipants,
			expires: Date.now() + GROUP_META_TTL_MS
		};
	};
	const summarizeGroupMetaForReconnectCache = (meta) => ({
		subject: meta.subject,
		expires: Date.now() + GROUP_META_TTL_MS
	});
	const getGroupMeta = async (jid) => {
		const cached = readGroupMetadataCacheEntry(groupMetaCache, jid);
		if (cached) return cached;
		try {
			const entry = await summarizeGroupMeta(await (getCurrentSock() ?? sock).groupMetadata(jid));
			rememberGroupMetadataCacheEntry(groupMetadataCache, jid, {
				subject: entry.subject,
				expires: entry.expires
			});
			rememberGroupMetadataCacheEntry(groupMetaCache, jid, entry);
			return entry;
		} catch (err) {
			const hydrated = readGroupMetadataCacheEntry(groupMetadataCache, jid);
			if (hydrated) {
				rememberGroupMetadataCacheEntry(groupMetaCache, jid, hydrated);
				logWhatsAppVerbose(options.verbose, `Using cached group metadata for ${jid} after fetch failure: ${String(err)}`);
				return hydrated;
			}
			logWhatsAppVerbose(options.verbose, `Failed to fetch group metadata for ${jid}: ${String(err)}`);
			return { expires: Date.now() + GROUP_META_TTL_MS };
		}
	};
	const resolveOutboundMentionsForGroup = async (jid, text) => {
		if (!isGroupJid(jid) || !mayContainWhatsAppOutboundMention(text)) return {
			text,
			mentionedJids: []
		};
		return resolveWhatsAppOutboundMentions({
			chatJid: jid,
			text,
			participants: (await getGroupMeta(jid)).mentionParticipants
		});
	};
	const applyOutboundMentionsToContent = async (jid, content) => {
		if ("text" in content && typeof content.text === "string") {
			const resolved = await resolveOutboundMentionsForGroup(jid, content.text);
			return addWhatsAppOutboundMentionsToContent({
				...content,
				text: resolved.text
			}, resolved.mentionedJids);
		}
		const caption = content.caption;
		if (typeof caption === "string") {
			const resolved = await resolveOutboundMentionsForGroup(jid, caption);
			return addWhatsAppOutboundMentionsToContent({
				...content,
				caption: resolved.text
			}, resolved.mentionedJids);
		}
		return content;
	};
	const normalizeInboundMessage = async (msg) => {
		const id = msg.key?.id ?? void 0;
		const remoteJid = msg.key?.remoteJid;
		if (!remoteJid) return null;
		if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) return null;
		const group = isGroupJid(remoteJid);
		if (Boolean(msg.key?.fromMe) && id && isRecentOutboundMessage({
			accountId: options.accountId,
			remoteJid,
			messageId: id
		})) {
			logWhatsAppVerbose(options.verbose, `Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`);
			return null;
		}
		if (!hasInboundUserContent(msg.message ?? void 0)) return null;
		const participantJid = msg.key?.participant ?? void 0;
		const from = group ? remoteJid : await resolveInboundJid(remoteJid);
		if (!from) return null;
		const senderE164 = group ? participantJid ? await resolveInboundJid(participantJid) : null : from;
		let groupSubject;
		let groupParticipants;
		if (group) {
			const meta = await getGroupMeta(remoteJid);
			groupSubject = meta.subject;
			groupParticipants = meta.participants;
		}
		const messageTimestampMs = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1e3 : void 0;
		const access = await checkInboundAccessControl({
			cfg: options.loadConfig?.() ?? options.cfg,
			accountId: options.accountId,
			from,
			selfE164: self.e164 ?? null,
			senderE164,
			group,
			pushName: msg.pushName ?? void 0,
			isFromMe: Boolean(msg.key?.fromMe),
			messageTimestampMs,
			connectedAtMs,
			verbose: options.verbose,
			sock: { sendMessage: (jid, content) => sendTrackedMessage(jid, content) },
			remoteJid
		});
		if (!access.allowed) return null;
		return {
			id,
			remoteJid,
			group,
			participantJid,
			from,
			senderE164,
			groupSubject,
			groupParticipants,
			messageTimestampMs,
			access
		};
	};
	const maybeMarkInboundAsRead = async (inbound) => {
		const { id, remoteJid, participantJid, access } = inbound;
		if (id && !access.isSelfChat && options.sendReadReceipts !== false) try {
			await sock.readMessages([{
				remoteJid,
				id,
				participant: participantJid,
				fromMe: false
			}]);
			const suffix = participantJid ? ` (participant ${participantJid})` : "";
			logWhatsAppVerbose(options.verbose, `Marked message ${id} as read for ${remoteJid}${suffix}`);
		} catch (err) {
			logWhatsAppVerbose(options.verbose, `Failed to mark message ${id} read: ${String(err)}`);
		}
		else if (id && access.isSelfChat && options.verbose) logWhatsAppVerbose(options.verbose, `Self-chat mode: skipping read receipt for ${id}`);
	};
	const enrichInboundMessage = async (msg) => {
		const location = extractLocationData(msg.message ?? void 0);
		const locationText = location ? formatLocationText(location) : void 0;
		const contactContext = extractContactContext(msg.message ?? void 0);
		let body = extractText(msg.message ?? void 0);
		if (locationText) body = [body, locationText].filter(Boolean).join("\n").trim();
		if (!body) {
			body = extractMediaPlaceholder(msg.message ?? void 0);
			if (!body) return null;
		}
		const replyContext = describeReplyContext(msg.message);
		let mediaPath;
		let mediaType;
		let mediaFileName;
		const saveInboundMedia = async (inboundMedia) => {
			if (!inboundMedia) return;
			const maxBytes = (typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0 ? options.mediaMaxMb : 50) * 1024 * 1024;
			mediaPath = (await saveMediaBuffer(inboundMedia.buffer, inboundMedia.mimetype, "inbound", maxBytes, inboundMedia.fileName)).path;
			mediaType = inboundMedia.mimetype;
			mediaFileName = inboundMedia.fileName;
		};
		try {
			await saveInboundMedia(await downloadInboundMedia(msg, sock));
			if (!mediaPath && replyContext) await saveInboundMedia(await downloadQuotedInboundMedia(msg, sock));
		} catch (err) {
			logWhatsAppVerbose(options.verbose, `Inbound media download failed: ${String(err)}`);
		}
		return {
			body,
			location: location ?? void 0,
			contactContext,
			replyContext,
			mediaPath,
			mediaType,
			mediaFileName
		};
	};
	const enqueueInboundMessage = async (msg, inbound, enriched) => {
		const chatJid = inbound.remoteJid;
		const sendComposing = async () => {
			const currentSock = getCurrentSock();
			if (!currentSock) return;
			try {
				await currentSock.sendPresenceUpdate("composing", chatJid);
			} catch (err) {
				logWhatsAppVerbose(options.verbose, `Presence update failed: ${String(err)}`);
			}
		};
		const reply = async (text, options) => {
			const resolved = await resolveOutboundMentionsForGroup(chatJid, text);
			return normalizeWhatsAppSendResult(await sendTrackedMessage(chatJid, addWhatsAppOutboundMentionsToContent({ text: resolved.text }, resolved.mentionedJids), options), "text");
		};
		const sendMedia = async (payload, options) => {
			return normalizeWhatsAppSendResult(await sendTrackedMessage(chatJid, await applyOutboundMentionsToContent(chatJid, payload), options), "media");
		};
		const timestamp = inbound.messageTimestampMs;
		const mentionedJids = extractMentionedJids(msg.message);
		const senderName = msg.pushName ?? void 0;
		inboundLogger.info({
			from: inbound.from,
			to: self.e164 ?? "me",
			body: enriched.body,
			mediaPath: enriched.mediaPath,
			mediaType: enriched.mediaType,
			mediaFileName: enriched.mediaFileName,
			timestamp
		}, "inbound message");
		const inboundMessage = {
			id: inbound.id,
			from: inbound.from,
			conversationId: inbound.from,
			to: self.e164 ?? "me",
			accountId: inbound.access.resolvedAccountId,
			accessControlPassed: true,
			body: enriched.body,
			pushName: senderName,
			timestamp,
			chatType: inbound.group ? "group" : "direct",
			chatId: inbound.remoteJid,
			sender: resolveComparableIdentity({
				jid: inbound.participantJid,
				e164: inbound.senderE164 ?? void 0,
				name: senderName
			}),
			senderJid: inbound.participantJid,
			senderE164: inbound.senderE164 ?? void 0,
			senderName,
			replyTo: enriched.replyContext ?? void 0,
			replyToId: enriched.replyContext?.id,
			replyToBody: enriched.replyContext?.body,
			replyToSender: enriched.replyContext?.sender?.label ?? void 0,
			replyToSenderJid: enriched.replyContext?.sender?.jid ?? void 0,
			replyToSenderE164: enriched.replyContext?.sender?.e164 ?? void 0,
			groupSubject: inbound.groupSubject,
			groupParticipants: inbound.groupParticipants,
			mentions: mentionedJids ?? void 0,
			mentionedJids: mentionedJids ?? void 0,
			self,
			selfJid: self.jid ?? void 0,
			selfLid: self.lid ?? void 0,
			selfE164: self.e164 ?? void 0,
			fromMe: Boolean(msg.key?.fromMe),
			location: enriched.location ?? void 0,
			untrustedStructuredContext: enriched.contactContext ? [{
				label: "WhatsApp contact",
				source: "whatsapp",
				type: enriched.contactContext.kind,
				payload: enriched.contactContext
			}] : void 0,
			sendComposing,
			reply,
			sendMedia,
			mediaPath: enriched.mediaPath,
			mediaType: enriched.mediaType,
			mediaFileName: enriched.mediaFileName,
			dedupeKey: inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : void 0
		};
		if (inboundMessage.id) cacheInboundMessageMeta(inboundMessage.accountId, inboundMessage.chatId, inboundMessage.id, {
			participant: inboundMessage.senderJid,
			participantE164: inboundMessage.chatType === "direct" ? inboundMessage.senderE164 : void 0,
			body: inboundMessage.body,
			fromMe: inboundMessage.fromMe
		});
		try {
			Promise.resolve(debouncer.enqueue(inboundMessage)).catch((err) => {
				inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
				inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
			});
		} catch (err) {
			inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
			inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
		}
	};
	const handleMessagesUpsert = async (upsert) => {
		if (upsert.type !== "notify" && upsert.type !== "append") return;
		for (const msg of upsert.messages ?? []) {
			const inbound = await normalizeInboundMessage(msg);
			if (!inbound) continue;
			await maybeMarkInboundAsRead(inbound);
			if (upsert.type === "append") {
				const APPEND_RECENT_GRACE_MS = 6e4;
				const msgTsRaw = msg.messageTimestamp;
				const msgTsNum = msgTsRaw != null ? Number(msgTsRaw) : NaN;
				if ((Number.isFinite(msgTsNum) ? msgTsNum * 1e3 : 0) < connectedAtMs - APPEND_RECENT_GRACE_MS) continue;
			}
			const enriched = await enrichInboundMessage(msg);
			if (!enriched) continue;
			const dedupeKey = inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : "";
			if (dedupeKey && !await claimRecentInboundMessage(dedupeKey)) continue;
			recordAcceptedInboundActivity(options.accountId);
			await enqueueInboundMessage(msg, inbound, enriched);
		}
	};
	const handleConnectionUpdate = (update) => {
		try {
			if (update.connection === "close") {
				if (options.socketRef?.current === sock) options.socketRef.current = null;
				const status = getStatusCode(update.lastDisconnect?.error);
				resolveClose({
					status,
					isLoggedOut: status === LOGGED_OUT_STATUS,
					error: update.lastDisconnect?.error
				});
			}
		} catch (err) {
			inboundLogger.error({ error: String(err) }, "connection.update handler error");
			resolveClose({
				status: void 0,
				isLoggedOut: false,
				error: err
			});
		}
	};
	const detachMessagesUpsert = attachEmitterListener(sock.ev, "messages.upsert", handleMessagesUpsert);
	const detachConnectionUpdate = attachEmitterListener(sock.ev, "connection.update", handleConnectionUpdate);
	(async () => {
		try {
			const groups = await sock.groupFetchAllParticipating();
			for (const [jid, meta] of Object.entries(groups ?? {})) if (meta) rememberGroupMetadataCacheEntry(groupMetadataCache, jid, summarizeGroupMetaForReconnectCache(meta));
			logWhatsAppVerbose(options.verbose, `Hydrated ${Object.keys(groups ?? {}).length} participating groups on connect`);
		} catch (err) {
			const error = String(err);
			inboundLogger.warn({ error }, "failed hydrating participating groups on connect");
			inboundConsoleLog.warn(`Failed hydrating participating groups on connect: ${error}`);
			logWhatsAppVerbose(options.verbose, `Failed to hydrate participating groups on connect: ${error}`);
		}
	})();
	return {
		close: async () => {
			try {
				detachMessagesUpsert();
				detachConnectionUpdate();
				closeInboundMonitorSocket(sock);
			} catch (err) {
				logWhatsAppVerbose(options.verbose, `Socket close failed: ${String(err)}`);
			}
		},
		onClose,
		signalClose: (reason) => {
			resolveClose(reason ?? {
				status: void 0,
				isLoggedOut: false,
				error: "closed"
			});
		},
		...createWebSendApi({
			sock: {
				sendMessage: (jid, content, options) => sendTrackedMessage(jid, content, options),
				sendPresenceUpdate: async (presence, jid) => {
					const currentSock = getCurrentSock();
					if (!currentSock) throw new Error(RECONNECT_IN_PROGRESS_ERROR);
					return currentSock.sendPresenceUpdate(presence, jid);
				}
			},
			defaultAccountId: options.accountId,
			resolveOutboundMentions: ({ jid, text }) => resolveOutboundMentionsForGroup(jid, text),
			authDir: options.authDir
		})
	};
}
async function monitorWebInbox(options) {
	const sock = await createWaSocket(false, options.verbose, {
		authDir: options.authDir,
		...resolveWhatsAppSocketTiming(options.cfg)
	});
	await waitForWaConnection(sock);
	return attachWebInboxToSocket({
		...options,
		sock
	});
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/loggers.ts
const whatsappLog = createSubsystemLogger("gateway/channels/whatsapp");
const whatsappInboundLog = whatsappLog.child("inbound");
const whatsappOutboundLog = whatsappLog.child("outbound");
const whatsappHeartbeatLog = whatsappLog.child("heartbeat");
//#endregion
//#region extensions/whatsapp/src/auto-reply/mentions.ts
function buildMentionConfig(cfg, agentId) {
	return {
		mentionRegexes: buildMentionRegexes(cfg, agentId),
		allowFrom: cfg.channels?.whatsapp?.allowFrom
	};
}
function resolveMentionTargets(msg, authDir) {
	return {
		normalizedMentions: getMentionIdentities(msg, authDir),
		self: getSelfIdentity(msg, authDir)
	};
}
function isBotMentionedFromTargets(msg, mentionCfg, targets) {
	const clean = (text) => normalizeMentionText(text);
	const explicitSelfChatOverride = typeof mentionCfg.isSelfChat === "boolean";
	const isGroupConversation = isWhatsAppGroupJid(msg.from);
	const isSelfChat = explicitSelfChatOverride ? Boolean(mentionCfg.isSelfChat) : isSelfChatMode(targets.self.e164, mentionCfg.allowFrom) && !isGroupConversation;
	const hasMentions = targets.normalizedMentions.length > 0;
	if (hasMentions && !isSelfChat) {
		for (const mention of targets.normalizedMentions) if (identitiesOverlap(targets.self, mention)) return true;
		return false;
	} else if (hasMentions && isSelfChat) {}
	const bodyClean = clean(msg.body);
	if (mentionCfg.mentionRegexes.some((re) => re.test(bodyClean))) return true;
	if (targets.self.e164) {
		const selfDigits = targets.self.e164.replace(/\D/g, "");
		if (selfDigits) {
			if (bodyClean.replace(/[^\d]/g, "").includes(selfDigits)) return true;
			const bodyNoSpace = msg.body.replace(/[\s-]/g, "");
			if (new RegExp(`\\+?${selfDigits}`, "i").test(bodyNoSpace)) return true;
		}
	}
	return false;
}
function debugMention(msg, mentionCfg, authDir) {
	const mentionTargets = resolveMentionTargets(msg, authDir);
	return {
		wasMentioned: isBotMentionedFromTargets(msg, mentionCfg, mentionTargets),
		details: {
			from: msg.from,
			body: msg.body,
			bodyClean: normalizeMentionText(msg.body),
			mentionedJids: msg.mentions ?? msg.mentionedJids ?? null,
			normalizedMentionedJids: mentionTargets.normalizedMentions.length ? mentionTargets.normalizedMentions.map((identity) => getComparableIdentityValues(identity)) : null,
			selfJid: msg.self?.jid ?? msg.selfJid ?? null,
			selfLid: msg.self?.lid ?? msg.selfLid ?? null,
			selfE164: msg.self?.e164 ?? msg.selfE164 ?? null,
			resolvedSelf: mentionTargets.self
		}
	};
}
function resolveOwnerList(mentionCfg, selfE164) {
	const allowFrom = mentionCfg.allowFrom;
	return (Array.isArray(allowFrom) && allowFrom.length > 0 ? allowFrom : selfE164 ? [selfE164] : []).filter((entry) => Boolean(entry && entry !== "*")).map((entry) => normalizeE164(entry)).filter((entry) => Boolean(entry));
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor-state.ts
function cloneStatus(status) {
	return {
		...status,
		lastDisconnect: status.lastDisconnect ? { ...status.lastDisconnect } : null
	};
}
function isTerminalHealthState(healthState) {
	return healthState === "conflict" || healthState === "logged-out" || healthState === "stopped";
}
function createWebChannelStatusController(statusSink) {
	let lastDisconnectWasWatchdogRecovery = false;
	const status = {
		running: true,
		connected: false,
		reconnectAttempts: 0,
		lastConnectedAt: null,
		lastDisconnect: null,
		lastInboundAt: null,
		lastMessageAt: null,
		lastEventAt: null,
		lastError: null,
		healthState: "starting"
	};
	const emit = () => {
		statusSink?.(cloneStatus(status));
	};
	return {
		emit,
		snapshot: () => status,
		noteConnected(at = Date.now()) {
			Object.assign(status, createConnectedChannelStatusPatch(at));
			Object.assign(status, createTransportActivityStatusPatch(at));
			if (lastDisconnectWasWatchdogRecovery) {
				status.lastDisconnect = null;
				status.reconnectAttempts = 0;
				lastDisconnectWasWatchdogRecovery = false;
			}
			status.lastError = null;
			status.healthState = "healthy";
			emit();
		},
		noteInbound(at = Date.now()) {
			status.lastInboundAt = at;
			status.lastMessageAt = at;
			status.lastEventAt = at;
			Object.assign(status, createTransportActivityStatusPatch(at));
			if (status.connected) status.healthState = "healthy";
			emit();
		},
		noteTransportActivity(at = Date.now()) {
			if (status.lastTransportActivityAt === at) return;
			Object.assign(status, createTransportActivityStatusPatch(at));
			emit();
		},
		noteWatchdogStale(at = Date.now()) {
			status.lastEventAt = at;
			if (status.connected) status.healthState = "stale";
			emit();
		},
		noteReconnectAttempts(reconnectAttempts) {
			status.reconnectAttempts = reconnectAttempts;
			emit();
		},
		noteClose(params) {
			const at = params.at ?? Date.now();
			lastDisconnectWasWatchdogRecovery = params.watchdogRecovery === true;
			status.connected = false;
			status.lastEventAt = at;
			status.lastDisconnect = {
				at,
				status: params.statusCode,
				error: params.error,
				loggedOut: Boolean(params.loggedOut)
			};
			status.lastError = params.error ?? null;
			status.reconnectAttempts = params.reconnectAttempts;
			status.healthState = params.healthState;
			emit();
		},
		markStopped(at = Date.now()) {
			status.running = false;
			status.connected = false;
			status.lastEventAt = at;
			if (!isTerminalHealthState(status.healthState)) status.healthState = "stopped";
			emit();
		}
	};
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/echo.ts
function createEchoTracker(params) {
	const recentlySent = /* @__PURE__ */ new Set();
	const maxItems = Math.max(1, params.maxItems ?? 100);
	const buildCombinedKey = (p) => `combined:${p.sessionKey}:${p.combinedBody}`;
	const trim = () => {
		while (recentlySent.size > maxItems) {
			const firstKey = recentlySent.values().next().value;
			if (!firstKey) break;
			recentlySent.delete(firstKey);
		}
	};
	const rememberText = (text, opts) => {
		if (!text) return;
		recentlySent.add(text);
		if (opts.combinedBody && opts.combinedBodySessionKey) recentlySent.add(buildCombinedKey({
			sessionKey: opts.combinedBodySessionKey,
			combinedBody: opts.combinedBody
		}));
		if (opts.logVerboseMessage) params.logVerbose?.(`Added to echo detection set (size now: ${recentlySent.size}): ${text.slice(0, 50)}...`);
		trim();
	};
	return {
		rememberText,
		has: (key) => recentlySent.has(key),
		forget: (key) => {
			recentlySent.delete(key);
		},
		buildCombinedKey
	};
}
//#endregion
//#region extensions/whatsapp/src/group-session-key.ts
function resolveWhatsAppGroupAccountThreadId(accountId) {
	return `whatsapp-account-${normalizeAccountId(accountId)}`;
}
function resolveWhatsAppLegacyGroupSessionKey(params) {
	const accountId = normalizeAccountId(params.accountId);
	if (!accountId || accountId === "default" || !params.sessionKey.includes(":group:")) return null;
	const suffix = `:thread:${resolveWhatsAppGroupAccountThreadId(accountId)}`;
	return params.sessionKey.endsWith(suffix) ? params.sessionKey.slice(0, -suffix.length) : null;
}
function resolveWhatsAppGroupSessionRoute(route) {
	if (route.accountId === "default" || !route.sessionKey.includes(":group:")) return route;
	const scopedSession = resolveThreadSessionKeys({
		baseSessionKey: route.sessionKey,
		threadId: resolveWhatsAppGroupAccountThreadId(route.accountId)
	});
	return {
		...route,
		sessionKey: scopedSession.sessionKey
	};
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/group-activation.ts
function hasNamedWhatsAppAccounts(cfg) {
	return Object.keys(cfg.channels?.whatsapp?.accounts ?? {}).some((accountId) => normalizeAccountId(accountId) !== DEFAULT_ACCOUNT_ID);
}
function isActivationOnlyEntry(entry) {
	return entry?.groupActivation !== void 0 && typeof entry?.sessionId !== "string" && typeof entry?.updatedAt !== "number";
}
async function resolveGroupActivationFor(params) {
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
	const store = loadSessionStore(storePath);
	const legacySessionKey = resolveWhatsAppLegacyGroupSessionKey({
		sessionKey: params.sessionKey,
		accountId: params.accountId
	});
	const legacyEntry = legacySessionKey ? store[legacySessionKey] : void 0;
	const scopedEntry = store[params.sessionKey];
	const activation = (normalizeAccountId(params.accountId) === "default" && hasNamedWhatsAppAccounts(params.cfg) && isActivationOnlyEntry(scopedEntry) ? void 0 : scopedEntry?.groupActivation) ?? legacyEntry?.groupActivation;
	if (activation !== void 0 && scopedEntry?.groupActivation === void 0) await updateSessionStore(storePath, (nextStore) => {
		const nextScopedEntry = nextStore[params.sessionKey];
		if (nextScopedEntry?.groupActivation !== void 0) return;
		nextStore[params.sessionKey] = {
			...nextScopedEntry,
			groupActivation: activation
		};
	});
	const defaultActivation = !resolveWhatsAppInboundPolicy({
		cfg: params.cfg,
		accountId: params.accountId
	}).resolveConversationRequireMention(params.conversationId) ? "always" : "mention";
	return normalizeGroupActivation(activation) ?? defaultActivation;
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/ack-reaction.ts
async function maybeSendAckReaction(params) {
	if (!params.msg.id) return null;
	if (resolveWhatsAppReactionLevel({
		cfg: params.cfg,
		accountId: params.accountId
	}).level === "off") return null;
	const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
	const emoji = (ackConfig?.emoji ?? "").trim();
	const directEnabled = ackConfig?.direct ?? true;
	const groupMode = ackConfig?.group ?? "mentions";
	const conversationIdForCheck = params.msg.conversationId ?? params.msg.from;
	const activation = params.msg.chatType === "group" ? await resolveGroupActivationFor({
		cfg: params.cfg,
		accountId: params.accountId,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		conversationId: conversationIdForCheck
	}) : null;
	const shouldSendReaction = () => shouldAckReactionForWhatsApp({
		emoji,
		isDirect: params.msg.chatType === "direct",
		isGroup: params.msg.chatType === "group",
		directEnabled,
		groupMode,
		wasMentioned: params.msg.wasMentioned === true,
		groupActivated: activation === "always"
	});
	if (!shouldSendReaction()) return null;
	params.info({
		chatId: params.msg.chatId,
		messageId: params.msg.id,
		emoji
	}, "sending ack reaction");
	const sender = getSenderIdentity(params.msg);
	const reactionOptions = {
		verbose: params.verbose,
		fromMe: false,
		...sender.jid ? { participant: sender.jid } : {},
		...params.accountId ? { accountId: params.accountId } : {},
		cfg: params.cfg
	};
	return createAckReactionHandle({
		ackReactionValue: emoji,
		send: () => sendReactionWhatsApp(params.msg.chatId, params.msg.id, emoji, reactionOptions),
		remove: () => sendReactionWhatsApp(params.msg.chatId, params.msg.id, "", reactionOptions),
		onSendError: (err) => {
			params.warn({
				error: formatError(err),
				chatId: params.msg.chatId,
				messageId: params.msg.id
			}, "failed to send ack reaction");
			logVerbose(`WhatsApp ack reaction failed for chat ${params.msg.chatId}: ${formatError(err)}`);
		}
	});
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/broadcast.ts
function buildBroadcastRouteKeys(params) {
	const sessionKey = buildAgentSessionKey({
		agentId: params.agentId,
		channel: "whatsapp",
		accountId: params.route.accountId,
		peer: {
			kind: params.msg.chatType === "group" ? "group" : "direct",
			id: params.peerId
		},
		dmScope: params.cfg.session?.dmScope,
		identityLinks: params.cfg.session?.identityLinks
	});
	const mainSessionKey = buildAgentMainSessionKey({
		agentId: params.agentId,
		mainKey: DEFAULT_MAIN_KEY
	});
	return {
		sessionKey,
		mainSessionKey,
		lastRoutePolicy: deriveLastRoutePolicy({
			sessionKey,
			mainSessionKey
		})
	};
}
async function maybeBroadcastMessage(params) {
	const broadcastAgents = params.cfg.broadcast?.[params.peerId];
	if (!broadcastAgents || !Array.isArray(broadcastAgents)) return false;
	if (broadcastAgents.length === 0) return false;
	const strategy = params.cfg.broadcast?.strategy || "parallel";
	whatsappInboundLog.info(`Broadcasting message to ${broadcastAgents.length} agents (${strategy})`);
	const agentIds = params.cfg.agents?.list?.map((agent) => normalizeAgentId$1(agent.id));
	const hasKnownAgents = (agentIds?.length ?? 0) > 0;
	const groupHistorySnapshot = params.msg.chatType === "group" ? params.groupHistories.get(params.groupHistoryKey) ?? [] : void 0;
	const processForAgent = async (agentId) => {
		const normalizedAgentId = normalizeAgentId$1(agentId);
		if (hasKnownAgents && !agentIds?.includes(normalizedAgentId)) {
			whatsappInboundLog.warn(`Broadcast agent ${agentId} not found in agents.list; skipping`);
			return false;
		}
		const routeKeys = buildBroadcastRouteKeys({
			cfg: params.cfg,
			msg: params.msg,
			route: params.route,
			peerId: params.peerId,
			agentId: normalizedAgentId
		});
		const baseAgentRoute = {
			...params.route,
			agentId: normalizedAgentId,
			...routeKeys
		};
		const agentRoute = params.msg.chatType === "group" ? resolveWhatsAppGroupSessionRoute(baseAgentRoute) : baseAgentRoute;
		try {
			const opts = {
				groupHistory: groupHistorySnapshot,
				suppressGroupHistoryClear: true
			};
			if (params.preflightAudioTranscript !== void 0) opts.preflightAudioTranscript = params.preflightAudioTranscript;
			if (params.ackAlreadySent === true) opts.ackAlreadySent = true;
			if (params.ackReaction !== void 0) opts.ackReaction = params.ackReaction;
			return await params.processMessage(params.msg, agentRoute, params.groupHistoryKey, opts);
		} catch (err) {
			whatsappInboundLog.error(`Broadcast agent ${agentId} failed: ${formatError(err)}`);
			return false;
		}
	};
	if (strategy === "sequential") for (const agentId of broadcastAgents) await processForAgent(agentId);
	else await Promise.allSettled(broadcastAgents.map(processForAgent));
	if (params.msg.chatType === "group") params.groupHistories.set(params.groupHistoryKey, []);
	return true;
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/commands.ts
function stripMentionsForCommand(text, mentionRegexes, selfE164) {
	let result = text;
	for (const re of mentionRegexes) result = result.replace(re, " ");
	if (selfE164) {
		const digits = selfE164.replace(/\D/g, "");
		if (digits) {
			const pattern = new RegExp(`\\+?${digits}`, "g");
			result = result.replace(pattern, " ");
		}
	}
	return result.replace(/\s+/g, " ").trim();
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/group-members.ts
function appendNormalizedUnique(entries, seen, ordered) {
	for (const entry of entries) {
		const normalized = normalizeE164(entry) ?? entry;
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		ordered.push(normalized);
	}
}
function noteGroupMember(groupMemberNames, conversationId, e164, name) {
	if (!e164 || !name) return;
	const key = normalizeE164(e164) ?? e164;
	if (!key) return;
	let roster = groupMemberNames.get(conversationId);
	if (!roster) {
		roster = /* @__PURE__ */ new Map();
		groupMemberNames.set(conversationId, roster);
	}
	roster.set(key, name);
}
function formatGroupMembers(params) {
	const { participants, roster, fallbackE164 } = params;
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	if (participants?.length) appendNormalizedUnique(participants, seen, ordered);
	if (roster) appendNormalizedUnique(roster.keys(), seen, ordered);
	if (ordered.length === 0 && fallbackE164) {
		const normalized = normalizeE164(fallbackE164) ?? fallbackE164;
		if (normalized) ordered.push(normalized);
	}
	if (ordered.length === 0) return;
	return ordered.map((entry) => {
		const name = roster?.get(entry);
		return name ? `${name} (${entry})` : entry;
	}).join(", ");
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/group-gating.ts
function isOwnerSender(baseMentionConfig, msg) {
	const sender = normalizeE164(getSenderIdentity(msg).e164 ?? "");
	if (!sender) return false;
	return resolveOwnerList(baseMentionConfig, getSelfIdentity(msg).e164 ?? void 0).includes(sender);
}
function recordPendingGroupHistoryEntry(params) {
	const senderIdentity = getSenderIdentity(params.msg);
	const sender = senderIdentity.name && senderIdentity.e164 ? `${senderIdentity.name} (${senderIdentity.e164})` : senderIdentity.name ?? senderIdentity.e164 ?? getPrimaryIdentityId(senderIdentity) ?? "Unknown";
	recordPendingHistoryEntryIfEnabled({
		historyMap: params.groupHistories,
		historyKey: params.groupHistoryKey,
		limit: params.groupHistoryLimit,
		entry: {
			sender,
			body: params.body ?? params.msg.body,
			timestamp: params.msg.timestamp,
			id: params.msg.id,
			senderJid: senderIdentity.jid ?? params.msg.senderJid
		}
	});
}
function skipGroupMessageAndStoreHistory(params, verboseMessage, body) {
	params.logVerbose(verboseMessage);
	recordPendingGroupHistoryEntry({
		msg: params.msg,
		body,
		groupHistories: params.groupHistories,
		groupHistoryKey: params.groupHistoryKey,
		groupHistoryLimit: params.groupHistoryLimit
	});
	return { shouldProcess: false };
}
async function applyGroupGating(params) {
	const sender = getSenderIdentity(params.msg);
	const self = getSelfIdentity(params.msg, params.authDir);
	const inboundPolicy = resolveWhatsAppInboundPolicy({
		cfg: params.cfg,
		accountId: params.msg.accountId,
		selfE164: self.e164 ?? null
	});
	const conversationGroupPolicy = inboundPolicy.resolveConversationGroupPolicy(params.conversationId);
	if (conversationGroupPolicy.allowlistEnabled && !conversationGroupPolicy.allowed) {
		params.logVerbose(`Skipping group message ${params.conversationId} (not in allowlist)`);
		return { shouldProcess: false };
	}
	noteGroupMember(params.groupMemberNames, params.groupHistoryKey, sender.e164 ?? void 0, sender.name ?? void 0);
	const baseMentionConfig = {
		...params.baseMentionConfig,
		allowFrom: inboundPolicy.configuredAllowFrom
	};
	const mentionConfig = {
		...buildMentionConfig(params.cfg, params.agentId),
		allowFrom: inboundPolicy.configuredAllowFrom
	};
	const mentionMsg = params.mentionText !== void 0 ? {
		...params.msg,
		body: params.mentionText
	} : params.msg;
	const commandBody = stripMentionsForCommand(mentionMsg.body, mentionConfig.mentionRegexes, self.e164);
	const activationCommand = parseActivationCommand(commandBody);
	const owner = isOwnerSender(baseMentionConfig, params.msg);
	const shouldBypassMention = owner && hasControlCommand(commandBody, params.cfg);
	if (activationCommand.hasCommand && !owner) return skipGroupMessageAndStoreHistory(params, `Ignoring /activation from non-owner in group ${params.conversationId}`);
	const mentionDebug = debugMention(mentionMsg, mentionConfig, params.authDir);
	params.replyLogger.debug({
		conversationId: params.conversationId,
		wasMentioned: mentionDebug.wasMentioned,
		...mentionDebug.details
	}, "group mention debug");
	const wasMentioned = mentionDebug.wasMentioned;
	const requireMention = await resolveGroupActivationFor({
		cfg: params.cfg,
		accountId: inboundPolicy.account.accountId,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		conversationId: params.conversationId
	}) !== "always";
	const replyContext = getReplyContext(params.msg, params.authDir);
	const mentionDecision = resolveInboundMentionDecision({
		facts: {
			canDetectMention: true,
			wasMentioned,
			implicitMentionKinds: implicitMentionKindWhen("quoted_bot", !(params.selfChatMode === true && identitiesOverlap(self, sender)) && identitiesOverlap(self, replyContext?.sender))
		},
		policy: {
			isGroup: true,
			requireMention,
			allowTextCommands: false,
			hasControlCommand: false,
			commandAuthorized: false
		}
	});
	const effectiveWasMentioned = mentionDecision.effectiveWasMentioned || shouldBypassMention;
	params.msg.wasMentioned = effectiveWasMentioned;
	if (!shouldBypassMention && requireMention && mentionDecision.shouldSkip) {
		if (params.deferMissingMention === true) {
			params.logVerbose(`Deferring group mention skip until audio preflight completes in ${params.conversationId}`);
			return {
				shouldProcess: false,
				needsMentionText: true
			};
		}
		return skipGroupMessageAndStoreHistory(params, `Group message stored for context (no mention detected) in ${params.conversationId}: ${mentionMsg.body}`, params.mentionText);
	}
	return { shouldProcess: true };
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/last-route.ts
function trackBackgroundTask(backgroundTasks, task) {
	backgroundTasks.add(task);
	const cleanup = () => {
		backgroundTasks.delete(task);
	};
	task.then(cleanup, cleanup);
}
function updateLastRouteInBackground(params) {
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.storeAgentId });
	const task = updateLastRoute({
		storePath,
		sessionKey: params.sessionKey,
		deliveryContext: {
			channel: params.channel,
			to: params.to,
			accountId: params.accountId
		},
		ctx: params.ctx
	}).catch((err) => {
		params.warn({
			error: formatError(err),
			storePath,
			sessionKey: params.sessionKey,
			to: params.to
		}, "failed updating last route");
	});
	trackBackgroundTask(params.backgroundTasks, task);
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/peer.ts
function resolvePeerId(msg) {
	if (msg.chatType === "group") return msg.conversationId ?? msg.from;
	const sender = getSenderIdentity(msg);
	if (sender.e164) return normalizeE164(sender.e164) ?? sender.e164;
	if (msg.from.includes("@")) return jidToE164(msg.from) ?? msg.from;
	return normalizeE164(msg.from) ?? msg.from;
}
//#endregion
//#region extensions/whatsapp/src/system-prompt.ts
function resolveWhatsAppGroupSystemPrompt(params) {
	if (!params.groupId) return;
	const groups = params.accountConfig?.groups;
	const specific = groups?.[params.groupId];
	if (specific != null && specific.systemPrompt != null) return specific.systemPrompt.trim() || void 0;
	const wildcard = groups?.["*"]?.systemPrompt;
	return wildcard != null ? wildcard.trim() || void 0 : void 0;
}
function resolveWhatsAppDirectSystemPrompt(params) {
	if (!params.peerId) return;
	const direct = params.accountConfig?.direct;
	const specific = direct?.[params.peerId];
	if (specific != null && specific.systemPrompt != null) return specific.systemPrompt.trim() || void 0;
	const wildcard = direct?.["*"]?.systemPrompt;
	return wildcard != null ? wildcard.trim() || void 0 : void 0;
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/util.ts
function elide(text, limit = 400) {
	if (!text) return text;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}… (truncated ${text.length - limit} chars)`;
}
function isLikelyWhatsAppCryptoError(reason) {
	const formatReason = (value) => {
		if (value == null) return "";
		if (typeof value === "string") return value;
		if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
		if (typeof value === "object") try {
			return JSON.stringify(value);
		} catch {
			return Object.prototype.toString.call(value);
		}
		if (typeof value === "number") return String(value);
		if (typeof value === "boolean") return String(value);
		if (typeof value === "bigint") return String(value);
		if (typeof value === "symbol") return value.description ?? value.toString();
		if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]";
		return Object.prototype.toString.call(value);
	};
	const haystack = normalizeLowercaseStringOrEmpty(reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : formatReason(reason));
	if (!(haystack.includes("unsupported state or unable to authenticate data") || haystack.includes("bad mac"))) return false;
	return haystack.includes("baileys") || haystack.includes("noise-handler") || haystack.includes("aesdecryptgcm");
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/deliver-reply.ts
function resolveWhatsAppReceiptKind(results) {
	if (results.length > 0 && results.every((result) => result.kind === "text")) return "text";
	if (results.length > 0 && results.every((result) => result.kind === "media")) return "media";
	return "unknown";
}
function createWhatsAppReplyDeliveryReceipt(results) {
	const receiptResultsById = /* @__PURE__ */ new Map();
	for (const result of results) {
		if (result.receipt?.parts.length) {
			for (const part of result.receipt.parts) receiptResultsById.set(part.platformMessageId, {
				...part.raw ?? {
					channel: "whatsapp",
					messageId: part.platformMessageId
				},
				meta: {
					...part.raw?.meta,
					kind: result.kind,
					providerAccepted: result.providerAccepted
				}
			});
			continue;
		}
		for (const messageId of listWhatsAppSendResultMessageIds(result)) receiptResultsById.set(messageId, {
			channel: "whatsapp",
			messageId,
			meta: {
				kind: result.kind,
				providerAccepted: result.providerAccepted
			}
		});
	}
	return createMessageReceiptFromOutboundResults({
		results: [...receiptResultsById.values()],
		kind: resolveWhatsAppReceiptKind(results)
	});
}
async function deliverWebReply(params) {
	const { replyResult, msg, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } = params;
	const replyStarted = Date.now();
	const sendResults = [];
	const rememberSendResult = (result) => {
		if (result) sendResults.push(result);
	};
	const finishDelivery = () => {
		return {
			results: sendResults,
			receipt: createWhatsAppReplyDeliveryReceipt(sendResults),
			providerAccepted: sendResults.some((result) => result.providerAccepted)
		};
	};
	if (isReasoningReplyPayload(replyResult)) {
		whatsappOutboundLog.debug(`Suppressed reasoning payload to ${msg.from}`);
		return finishDelivery();
	}
	const tableMode = params.tableMode ?? "code";
	const chunkMode = params.chunkMode ?? "length";
	const normalizedReply = params.normalizedReplyResult ?? normalizeWhatsAppOutboundPayload(replyResult, { normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation });
	const textChunks = chunkMarkdownTextWithMode(markdownToWhatsApp(convertMarkdownTables(normalizedReply.text ?? "", tableMode)), textLimit, chunkMode);
	const mediaList = normalizedReply.mediaUrls ?? [];
	const getQuote = () => {
		if (!replyResult.replyToId) return;
		const cached = lookupInboundMessageMeta(msg.accountId, msg.chatId, replyResult.replyToId);
		return buildQuotedMessageOptions({
			messageId: replyResult.replyToId,
			remoteJid: msg.chatId,
			fromMe: cached?.fromMe ?? false,
			participant: cached?.participant ?? (msg.chatType === "group" ? msg.senderJid : void 0),
			messageText: cached?.body ?? ""
		});
	};
	const sendWithRetry = async (fn, label, maxAttempts = 3) => {
		return await sendWhatsAppOutboundWithRetry({
			send: fn,
			maxAttempts,
			onRetry: ({ attempt, maxAttempts: retryMaxAttempts, backoffMs, errorText }) => {
				logVerbose(`Retrying ${label} to ${msg.from} after failure (${attempt}/${retryMaxAttempts - 1}) in ${backoffMs}ms: ${errorText}`);
			}
		});
	};
	if (mediaList.length === 0 && textChunks.length) {
		const totalChunks = textChunks.length;
		for (const [index, chunk] of textChunks.entries()) {
			const chunkStarted = Date.now();
			const quote = getQuote();
			rememberSendResult(await sendWithRetry(() => msg.reply(chunk, quote), "text"));
			if (!skipLog) {
				const durationMs = Date.now() - chunkStarted;
				whatsappOutboundLog.debug(`Sent chunk ${index + 1}/${totalChunks} to ${msg.from} (${durationMs.toFixed(0)}ms)`);
			}
		}
		const delivery = finishDelivery();
		const logPayload = {
			correlationId: msg.id ?? newConnectionId(),
			connectionId: connectionId ?? null,
			to: msg.from,
			from: msg.to,
			text: elide(replyResult.text, 240),
			mediaUrl: null,
			mediaSizeBytes: null,
			mediaKind: null,
			durationMs: Date.now() - replyStarted
		};
		if (delivery.providerAccepted) replyLogger.info(logPayload, "auto-reply sent (text)");
		else replyLogger.warn(logPayload, "auto-reply text was not accepted by WhatsApp provider");
		return delivery;
	}
	const remainingText = [...textChunks];
	await sendMediaWithLeadingCaption({
		mediaUrls: mediaList,
		caption: remainingText.shift() || "",
		send: async ({ mediaUrl, caption }) => {
			const media = await prepareWhatsAppOutboundMedia(await loadWebMedia(mediaUrl, {
				maxBytes: maxMediaBytes,
				localRoots: params.mediaLocalRoots
			}), mediaUrl);
			if (shouldLogVerbose()) {
				logVerbose(`Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`);
				logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
			}
			if (media.kind === "image") {
				const quote = getQuote();
				rememberSendResult(await sendWithRetry(() => msg.sendMedia({
					image: media.buffer,
					caption,
					mimetype: media.mimetype
				}, quote), "media:image"));
			} else if (media.kind === "audio") {
				const quote = getQuote();
				rememberSendResult(await sendWithRetry(() => msg.sendMedia({
					audio: media.buffer,
					ptt: true,
					mimetype: media.mimetype
				}, quote), "media:audio"));
				if (caption) rememberSendResult(await sendWithRetry(() => msg.reply(caption, quote), "media:audio-text"));
			} else if (media.kind === "video") {
				const quote = getQuote();
				rememberSendResult(await sendWithRetry(() => msg.sendMedia({
					video: media.buffer,
					caption,
					mimetype: media.mimetype
				}, quote), "media:video"));
			} else {
				const quote = getQuote();
				rememberSendResult(await sendWithRetry(() => msg.sendMedia({
					document: media.buffer,
					fileName: media.fileName,
					caption,
					mimetype: media.mimetype
				}, quote), "media:document"));
			}
			whatsappOutboundLog.info(`Sent media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`);
			replyLogger.info({
				correlationId: msg.id ?? newConnectionId(),
				connectionId: connectionId ?? null,
				to: msg.from,
				from: msg.to,
				text: caption ?? null,
				mediaUrl,
				mediaSizeBytes: media.buffer.length,
				mediaKind: media.kind,
				durationMs: Date.now() - replyStarted
			}, "auto-reply sent (media)");
		},
		onError: async ({ error, mediaUrl, caption, isFirst }) => {
			whatsappOutboundLog.error(`Failed sending web media to ${msg.from}: ${formatError(error)}`);
			replyLogger.warn({
				err: error,
				mediaUrl
			}, "failed to send web media reply");
			if (!isFirst) return;
			const fallbackText = [remainingText.shift() ?? caption ?? "", "⚠️ Media failed."].filter(Boolean).join("\n");
			if (!fallbackText) return;
			whatsappOutboundLog.warn(`Media skipped; sent text-only to ${msg.from}`);
			rememberSendResult(await sendWithRetry(() => msg.reply(fallbackText, getQuote()), "media:fallback-text"));
		}
	});
	for (const chunk of remainingText) rememberSendResult(await sendWithRetry(() => msg.reply(chunk, getQuote()), "media:text"));
	return finishDelivery();
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/inbound-context.ts
function isWhatsAppSupplementalSenderAllowed(params) {
	if (params.allowFrom.includes("*")) return true;
	const senderValues = new Set(getComparableIdentityValues(params.sender));
	if (senderValues.size === 0) return false;
	for (const entry of params.allowFrom) {
		const rawEntry = entry.trim();
		if (!rawEntry) continue;
		const normalizedEntry = normalizeE164(rawEntry);
		if (normalizedEntry && senderValues.has(normalizedEntry) || senderValues.has(rawEntry)) return true;
	}
	return false;
}
function resolveVisibleWhatsAppGroupHistory(params) {
	if (params.groupPolicy !== "allowlist") return params.history;
	return filterSupplementalContextItems({
		items: params.history,
		mode: params.mode,
		kind: "history",
		isSenderAllowed: (entry) => isWhatsAppSupplementalSenderAllowed({
			allowFrom: params.groupAllowFrom,
			sender: entry.senderJid ? { jid: entry.senderJid } : null
		})
	}).items;
}
function resolveVisibleWhatsAppReplyContext(params) {
	const replyTo = getReplyContext(params.msg, params.authDir);
	if (!replyTo) return null;
	return evaluateSupplementalContextVisibility({
		mode: params.mode,
		kind: "quote",
		senderAllowed: params.msg.chatType !== "group" || params.groupPolicy !== "allowlist" ? true : isWhatsAppSupplementalSenderAllowed({
			allowFrom: params.groupAllowFrom,
			sender: replyTo.sender
		})
	}).include ? replyTo : null;
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/inbound-dispatch.ts
function logWhatsAppReplyDeliveryError(params) {
	params.replyLogger.error({
		err: params.err,
		replyKind: params.info.kind,
		correlationId: params.msg.id ?? null,
		connectionId: params.connectionId,
		conversationId: params.conversationId,
		chatId: params.msg.chatId ?? null,
		to: params.msg.from ?? null,
		from: params.msg.to ?? null
	}, "auto-reply delivery failed");
}
function resolveWhatsAppDisableBlockStreaming(cfg) {
	if (typeof cfg.channels?.whatsapp?.blockStreaming !== "boolean") return;
	return !cfg.channels.whatsapp.blockStreaming;
}
function resolveWhatsAppDeliverablePayload(payload, info) {
	if (payload.isReasoning === true || payload.isCompactionNotice === true) return null;
	if (payload.isError === true) return null;
	if (info.kind === "tool") {
		if (!resolveSendableOutboundReplyParts(payload).hasMedia) return null;
		return {
			...payload,
			text: void 0
		};
	}
	return payload;
}
function getWhatsAppPayloadMediaUrls(payload) {
	return new Set([...Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [], ...typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []].map((url) => url.trim()).filter(Boolean));
}
function hasWhatsAppMediaUrlOverlap(left, right) {
	for (const url of left) if (right.has(url)) return true;
	return false;
}
function shouldDeferWhatsAppMediaOnlyPayload(params) {
	return params.info.kind !== "final" && params.reply.hasMedia && !params.reply.text.trim() && params.mediaUrls.size > 0;
}
function createWhatsAppMediaOnlyReplyCoalescer(params) {
	const pendingMediaOnlyPayloads = [];
	const flushExceptDuplicateMedia = async (mediaUrls) => {
		const flushResult = {
			delivered: 0,
			droppedDuplicateMedia: 0
		};
		const pending = pendingMediaOnlyPayloads.splice(0);
		for (const candidate of pending) {
			if (mediaUrls && hasWhatsAppMediaUrlOverlap(candidate.mediaUrls, mediaUrls)) {
				flushResult.droppedDuplicateMedia += 1;
				continue;
			}
			await params.deliver(candidate);
			flushResult.delivered += 1;
		}
		return flushResult;
	};
	return {
		defer(pending) {
			pendingMediaOnlyPayloads.push(pending);
		},
		flushExceptDuplicateMedia,
		flushAll: () => flushExceptDuplicateMedia()
	};
}
function logWhatsAppMediaOnlyFlushResult(result) {
	if (!shouldLogVerbose()) return;
	if (result.droppedDuplicateMedia > 0) logVerbose(`Dropped ${result.droppedDuplicateMedia} deferred media-only WhatsApp reply payload(s) superseded by captioned media`);
	if (result.delivered > 0) logVerbose(`Flushed ${result.delivered} deferred media-only WhatsApp reply payload(s)`);
}
function resolveWhatsAppResponsePrefix(params) {
	const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
	return params.pipelineResponsePrefix ?? (configuredResponsePrefix === void 0 && params.isSelfChat ? resolveIdentityNamePrefix$1(params.cfg, params.agentId) : void 0);
}
function buildWhatsAppInboundContext(params) {
	const inboundHistory = params.msg.chatType === "group" ? (params.groupHistory ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : void 0;
	return finalizeInboundContext({
		Body: params.combinedBody,
		BodyForAgent: params.bodyForAgent ?? params.msg.body,
		InboundHistory: inboundHistory,
		RawBody: params.rawBody ?? params.msg.body,
		CommandBody: params.commandBody ?? params.msg.body,
		Transcript: params.transcript,
		From: params.msg.from,
		To: params.msg.to,
		SessionKey: params.route.sessionKey,
		AccountId: params.route.accountId,
		MessageSid: params.msg.id,
		ReplyToId: params.visibleReplyTo?.id,
		ReplyToBody: params.visibleReplyTo?.body,
		ReplyToSender: params.visibleReplyTo?.sender?.label,
		MediaPath: params.msg.mediaPath,
		MediaUrl: params.msg.mediaUrl,
		MediaType: params.msg.mediaType,
		MediaTranscribedIndexes: params.mediaTranscribedIndexes,
		ChatType: params.msg.chatType,
		Timestamp: params.msg.timestamp,
		ConversationLabel: params.msg.chatType === "group" ? params.conversationId : params.msg.from,
		GroupSubject: params.msg.groupSubject,
		GroupMembers: formatGroupMembers({
			participants: params.msg.groupParticipants,
			roster: params.groupMemberRoster,
			fallbackE164: params.sender.e164
		}),
		SenderName: params.sender.name,
		SenderId: params.sender.id ?? params.sender.e164,
		SenderE164: params.sender.e164,
		CommandAuthorized: params.commandAuthorized,
		ReplyThreading: params.replyThreading,
		WasMentioned: params.msg.wasMentioned,
		GroupSystemPrompt: params.groupSystemPrompt,
		UntrustedStructuredContext: params.msg.untrustedStructuredContext,
		...params.msg.location ? toLocationContext(params.msg.location) : {},
		Provider: "whatsapp",
		Surface: "whatsapp",
		OriginatingChannel: "whatsapp",
		OriginatingTo: params.msg.from
	});
}
function resolveWhatsAppDmRouteTarget(params) {
	if (params.msg.chatType === "group") return;
	if (params.senderE164) return params.normalizeE164(params.senderE164) ?? void 0;
	if (params.msg.from.includes("@")) return jidToE164(params.msg.from) ?? void 0;
	return params.normalizeE164(params.msg.from) ?? void 0;
}
function updateWhatsAppMainLastRoute(params) {
	const shouldUpdateMainLastRoute = !params.pinnedMainDmRecipient || params.pinnedMainDmRecipient === params.dmRouteTarget;
	const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
		route: params.route,
		sessionKey: params.route.sessionKey
	});
	if (params.dmRouteTarget && inboundLastRouteSessionKey === params.route.mainSessionKey && shouldUpdateMainLastRoute) {
		params.updateLastRoute({
			cfg: params.cfg,
			backgroundTasks: params.backgroundTasks,
			storeAgentId: params.route.agentId,
			sessionKey: params.route.mainSessionKey,
			channel: "whatsapp",
			to: params.dmRouteTarget,
			accountId: params.route.accountId,
			ctx: params.ctx,
			warn: params.warn
		});
		return;
	}
	if (params.dmRouteTarget && inboundLastRouteSessionKey === params.route.mainSessionKey && params.pinnedMainDmRecipient) logVerbose(`Skipping main-session last route update for ${params.dmRouteTarget} (pinned owner ${params.pinnedMainDmRecipient})`);
}
async function dispatchWhatsAppBufferedReply(params) {
	const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
	const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
	const tableMode = resolveMarkdownTableMode({
		cfg: params.cfg,
		channel: "whatsapp",
		accountId: params.route.accountId
	});
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.route.agentId);
	const sourceReplyChatType = typeof params.context.ChatType === "string" ? params.context.ChatType : params.msg.chatType;
	const sourceReplyDeliveryMode = sourceReplyChatType === "group" || sourceReplyChatType === "channel" ? resolveChannelSourceReplyDeliveryMode({
		cfg: params.cfg,
		ctx: {
			ChatType: sourceReplyChatType,
			CommandSource: params.context.CommandSource === "native" ? "native" : void 0
		}
	}) : void 0;
	const disableBlockStreaming = sourceReplyDeliveryMode === "message_tool_only" ? true : resolveWhatsAppDisableBlockStreaming(params.cfg);
	let didSendReply = false;
	let didLogHeartbeatStrip = false;
	const deliverNormalizedPayload = async (normalizedDeliveryPayload, info) => {
		const reply = resolveSendableOutboundReplyParts(normalizedDeliveryPayload);
		if (!reply.hasMedia && !reply.text.trim()) return;
		if (!(await params.deliverReply({
			replyResult: normalizedDeliveryPayload,
			normalizedReplyResult: normalizedDeliveryPayload,
			msg: params.msg,
			mediaLocalRoots,
			maxMediaBytes: params.maxMediaBytes,
			textLimit,
			chunkMode,
			replyLogger: params.replyLogger,
			connectionId: params.connectionId,
			skipLog: false,
			tableMode
		})).providerAccepted) {
			params.replyLogger.warn({
				correlationId: params.msg.id ?? null,
				connectionId: params.connectionId,
				conversationId: params.conversationId,
				chatId: params.msg.chatId,
				to: params.msg.from,
				from: params.msg.to,
				replyKind: info.kind
			}, "auto-reply was not accepted by WhatsApp provider");
			return;
		}
		didSendReply = true;
		const shouldLog = normalizedDeliveryPayload.text ? true : void 0;
		params.rememberSentText(normalizedDeliveryPayload.text, {
			combinedBody: params.context.Body,
			combinedBodySessionKey: params.route.sessionKey,
			logVerboseMessage: shouldLog
		});
		const fromDisplay = params.msg.chatType === "group" ? params.conversationId : params.msg.from ?? "unknown";
		if (shouldLogVerbose()) logVerbose(`Reply body: ${normalizedDeliveryPayload.text != null ? reply.text : "<media>"}${reply.hasMedia ? " (media)" : ""} -> ${fromDisplay}`);
	};
	const mediaOnlyCoalescer = createWhatsAppMediaOnlyReplyCoalescer({ deliver: async (pending) => {
		await deliverNormalizedPayload(pending.payload, pending.info);
	} });
	const { queuedFinal, counts } = await dispatchReplyWithBufferedBlockDispatcher({
		ctx: params.context,
		cfg: params.cfg,
		replyResolver: params.replyResolver,
		dispatcherOptions: {
			...params.replyPipeline,
			onHeartbeatStrip: () => {
				if (!didLogHeartbeatStrip) {
					didLogHeartbeatStrip = true;
					logVerbose("Stripped stray HEARTBEAT_OK token from web reply");
				}
			},
			deliver: async (payload, info) => {
				const deliveryPayload = resolveWhatsAppDeliverablePayload(payload, info);
				if (!deliveryPayload) return;
				const normalizedOutboundPayload = normalizeWhatsAppOutboundPayload(deliveryPayload, { normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation });
				const normalizedDeliveryPayload = deliveryPayload.text === void 0 ? {
					...normalizedOutboundPayload,
					text: void 0
				} : normalizedOutboundPayload;
				const reply = resolveSendableOutboundReplyParts(normalizedDeliveryPayload);
				if (!reply.hasMedia && !reply.text.trim()) return;
				if (!reply.hasMedia) {
					logWhatsAppMediaOnlyFlushResult(await mediaOnlyCoalescer.flushAll());
					const durable = await deliverInboundReplyWithMessageSendContext({
						cfg: params.cfg,
						channel: "whatsapp",
						accountId: params.route.accountId,
						agentId: params.route.agentId,
						ctxPayload: params.context,
						payload: normalizedDeliveryPayload,
						info,
						to: params.msg.from,
						formatting: {
							textLimit,
							tableMode,
							chunkMode
						}
					});
					if (durable.status === "failed") throw durable.error;
					if (durable.status === "handled_visible") {
						didSendReply = true;
						const shouldLog = normalizedDeliveryPayload.text ? true : void 0;
						params.rememberSentText(normalizedDeliveryPayload.text, {
							combinedBody: params.context.Body,
							combinedBodySessionKey: params.route.sessionKey,
							logVerboseMessage: shouldLog
						});
						return;
					}
					if (durable.status === "handled_no_send") return;
					await deliverNormalizedPayload(normalizedDeliveryPayload, info);
					return;
				}
				const mediaUrls = getWhatsAppPayloadMediaUrls(normalizedDeliveryPayload);
				if (shouldDeferWhatsAppMediaOnlyPayload({
					info,
					mediaUrls,
					reply
				})) {
					mediaOnlyCoalescer.defer({
						info,
						mediaUrls,
						payload: normalizedDeliveryPayload
					});
					return;
				}
				logWhatsAppMediaOnlyFlushResult(await mediaOnlyCoalescer.flushExceptDuplicateMedia(mediaUrls));
				await deliverNormalizedPayload(normalizedDeliveryPayload, info);
			},
			onReplyStart: params.msg.sendComposing,
			onError: (err, info) => {
				logWhatsAppReplyDeliveryError({
					err,
					info,
					connectionId: params.connectionId,
					conversationId: params.conversationId,
					msg: params.msg,
					replyLogger: params.replyLogger
				});
			}
		},
		replyOptions: {
			disableBlockStreaming,
			...sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {},
			onModelSelected: params.onModelSelected
		}
	});
	logWhatsAppMediaOnlyFlushResult(await mediaOnlyCoalescer.flushAll());
	if (!hasVisibleChannelTurnDispatch({
		queuedFinal,
		counts
	})) {
		if (params.shouldClearGroupHistory) params.groupHistories.set(params.groupHistoryKey, []);
		logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
		return false;
	}
	if (params.shouldClearGroupHistory) params.groupHistories.set(params.groupHistoryKey, []);
	return didSendReply;
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/message-line.runtime.ts
function normalizeAgentId(agentId) {
	return agentId.trim().toLowerCase() || "main";
}
function resolveIdentityNamePrefix(cfg, agentId) {
	const normalizedAgentId = normalizeAgentId(agentId);
	const identityName = cfg.agents?.list?.find((agent) => normalizeAgentId(agent.id ?? "") === normalizedAgentId)?.identity?.name?.trim();
	return identityName ? `[${identityName}]` : void 0;
}
function resolveMessagePrefix(cfg, agentId, opts) {
	const configured = opts?.configured ?? cfg.messages?.messagePrefix;
	if (configured !== void 0) return configured;
	if (opts?.hasAllowFrom === true) return "";
	return resolveIdentityNamePrefix(cfg, agentId) ?? opts?.fallback ?? "[openclaw]";
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/message-line.ts
function formatReplyContext(msg) {
	const replyTo = getReplyContext(msg);
	if (!replyTo?.body) return null;
	return `[Replying to ${replyTo.sender?.label ?? replyTo.sender?.e164 ?? "unknown sender"}${replyTo.id ? ` id:${replyTo.id}` : ""}]\n${replyTo.body}\n[/Replying]`;
}
function buildInboundLine(params) {
	const { cfg, msg, agentId, previousTimestamp, envelope } = params;
	const messagePrefix = resolveMessagePrefix(cfg, agentId, {
		configured: cfg.channels?.whatsapp?.messagePrefix,
		hasAllowFrom: (cfg.channels?.whatsapp?.allowFrom?.length ?? 0) > 0
	});
	const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
	const replyContext = formatReplyContext(msg);
	const baseLine = `${prefixStr}${msg.body}${replyContext ? `\n\n${replyContext}` : ""}`;
	const sender = getSenderIdentity(msg);
	return formatInboundEnvelope({
		channel: "WhatsApp",
		from: msg.chatType === "group" ? msg.from : msg.from?.replace(/^whatsapp:/, ""),
		timestamp: msg.timestamp,
		body: baseLine,
		chatType: msg.chatType,
		sender: {
			name: sender.name ?? void 0,
			e164: sender.e164 ?? void 0,
			id: getPrimaryIdentityId(sender) ?? void 0
		},
		previousTimestamp,
		envelope,
		fromMe: msg.fromMe
	});
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/process-message.ts
const WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS = {
	maxConcurrency: 8,
	maxQueue: 128,
	timeoutMs: 2e3
};
function readWhatsAppMessageReceivedHookOptIn(value) {
	if (!value || typeof value !== "object") return;
	return value.pluginHooks?.messageReceived === true ? true : void 0;
}
function shouldEmitWhatsAppMessageReceivedHooks(params) {
	const channelConfig = params.cfg.channels?.whatsapp;
	return readWhatsAppMessageReceivedHookOptIn(params.accountId && channelConfig?.accounts ? channelConfig.accounts[params.accountId] : void 0) ?? readWhatsAppMessageReceivedHookOptIn(channelConfig) ?? false;
}
function emitWhatsAppMessageReceivedHooks(params) {
	const canonical = deriveInboundMessageHookContext(params.ctx);
	const hookRunner = getGlobalHookRunner();
	if (hookRunner?.hasHooks("message_received")) fireAndForgetBoundedHook(() => hookRunner.runMessageReceived(toPluginMessageReceivedEvent(canonical), toPluginMessageContext(canonical)), "whatsapp: message_received plugin hook failed", void 0, WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS);
	fireAndForgetBoundedHook(() => triggerInternalHook(createInternalHookEvent("message", "received", params.sessionKey, toInternalMessageReceivedContext(canonical))), "whatsapp: message_received internal hook failed", void 0, WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS);
}
function emitWhatsAppMessageReceivedHooksIfEnabled(params) {
	if (!shouldEmitWhatsAppMessageReceivedHooks({
		cfg: params.cfg,
		accountId: params.accountId
	})) return;
	emitWhatsAppMessageReceivedHooks({
		ctx: params.ctx,
		sessionKey: params.sessionKey
	});
}
function resolvePinnedMainDmRecipient(params) {
	return resolvePinnedMainDmOwnerFromAllowlist({
		dmScope: params.cfg.session?.dmScope,
		allowFrom: params.allowFrom,
		normalizeEntry: (entry) => normalizeE164(entry)
	});
}
async function processMessage(params) {
	const conversationId = params.msg.conversationId ?? params.msg.from;
	const self = getSelfIdentity(params.msg);
	const inboundPolicy = resolveWhatsAppInboundPolicy({
		cfg: params.cfg,
		accountId: params.route.accountId ?? params.msg.accountId,
		selfE164: self.e164 ?? null
	});
	const account = inboundPolicy.account;
	const contextVisibilityMode = resolveChannelContextVisibilityMode({
		cfg: params.cfg,
		channel: "whatsapp",
		accountId: account.accountId
	});
	const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
		cfg: params.cfg,
		agentId: params.route.agentId,
		sessionKey: params.route.sessionKey
	});
	let audioTranscript = params.preflightAudioTranscript ?? void 0;
	const hasAudioBody = params.msg.mediaType?.startsWith("audio/") === true && params.msg.body === "<media:audio>";
	if (params.preflightAudioTranscript === void 0 && hasAudioBody && params.msg.mediaPath) try {
		const { transcribeFirstAudio } = await import("./audio-preflight.runtime-CrI7I1OZ.js");
		audioTranscript = await transcribeFirstAudio({
			ctx: {
				MediaPaths: [params.msg.mediaPath],
				MediaTypes: params.msg.mediaType ? [params.msg.mediaType] : void 0,
				From: params.msg.from,
				To: params.msg.to,
				Provider: "whatsapp",
				Surface: "whatsapp",
				OriginatingChannel: "whatsapp",
				OriginatingTo: conversationId,
				AccountId: params.route.accountId
			},
			cfg: params.cfg
		});
	} catch {
		if (shouldLogVerbose()) logVerbose("whatsapp: audio preflight transcription failed, using placeholder");
	}
	const msgForAgent = audioTranscript !== void 0 ? {
		...params.msg,
		body: audioTranscript
	} : params.msg;
	let combinedBody = buildInboundLine({
		cfg: params.cfg,
		msg: msgForAgent,
		agentId: params.route.agentId,
		previousTimestamp,
		envelope: envelopeOptions
	});
	let shouldClearGroupHistory = false;
	const visibleGroupHistory = params.msg.chatType === "group" ? resolveVisibleWhatsAppGroupHistory({
		history: params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [],
		mode: contextVisibilityMode,
		groupPolicy: inboundPolicy.groupPolicy,
		groupAllowFrom: inboundPolicy.groupAllowFrom
	}) : void 0;
	if (params.msg.chatType === "group") {
		const history = visibleGroupHistory ?? [];
		if (history.length > 0) combinedBody = buildHistoryContextFromEntries({
			entries: history.map((m) => ({
				sender: m.sender,
				body: m.body,
				timestamp: m.timestamp
			})),
			currentMessage: combinedBody,
			excludeLast: false,
			formatEntry: (entry) => {
				return formatInboundEnvelope({
					channel: "WhatsApp",
					from: conversationId,
					timestamp: entry.timestamp,
					body: entry.body,
					chatType: "group",
					senderLabel: entry.sender,
					envelope: envelopeOptions
				});
			}
		});
		shouldClearGroupHistory = !(params.suppressGroupHistoryClear ?? false);
	}
	const combinedEchoKey = params.buildCombinedEchoKey({
		sessionKey: params.route.sessionKey,
		combinedBody
	});
	if (params.echoHas(combinedEchoKey)) {
		logVerbose("Skipping auto-reply: detected echo for combined message");
		params.echoForget(combinedEchoKey);
		return false;
	}
	let ackReaction = params.ackReaction ?? null;
	if (!ackReaction && params.ackAlreadySent !== true) ackReaction = await maybeSendAckReaction({
		cfg: params.cfg,
		msg: params.msg,
		agentId: params.route.agentId,
		sessionKey: params.route.sessionKey,
		conversationId,
		verbose: params.verbose,
		accountId: account.accountId,
		info: params.replyLogger.info.bind(params.replyLogger),
		warn: params.replyLogger.warn.bind(params.replyLogger)
	});
	const correlationId = params.msg.id ?? newConnectionId();
	params.replyLogger.info({
		connectionId: params.connectionId,
		correlationId,
		from: params.msg.chatType === "group" ? conversationId : params.msg.from,
		to: params.msg.to,
		body: elide(combinedBody, 240),
		mediaType: params.msg.mediaType ?? null,
		mediaPath: params.msg.mediaPath ?? null
	}, "inbound web message");
	const fromDisplay = params.msg.chatType === "group" ? conversationId : params.msg.from;
	const kindLabel = params.msg.mediaType ? `, ${params.msg.mediaType}` : "";
	whatsappInboundLog.info(`Inbound message ${fromDisplay} -> ${params.msg.to} (${params.msg.chatType}${kindLabel}, ${combinedBody.length} chars)`);
	if (shouldLogVerbose()) whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
	const sender = getSenderIdentity(params.msg);
	const visibleReplyTo = resolveVisibleWhatsAppReplyContext({
		msg: params.msg,
		authDir: account.authDir,
		mode: contextVisibilityMode,
		groupPolicy: inboundPolicy.groupPolicy,
		groupAllowFrom: inboundPolicy.groupAllowFrom
	});
	const dmRouteTarget = resolveWhatsAppDmRouteTarget({
		msg: params.msg,
		senderE164: sender.e164 ?? void 0,
		normalizeE164
	});
	const commandAuthorized = shouldComputeCommandAuthorized(params.msg.body, params.cfg) ? await resolveWhatsAppCommandAuthorized({
		cfg: params.cfg,
		msg: params.msg,
		policy: inboundPolicy
	}) : void 0;
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg: params.cfg,
		agentId: params.route.agentId,
		channel: "whatsapp",
		accountId: params.route.accountId
	});
	const responsePrefix = resolveWhatsAppResponsePrefix({
		cfg: params.cfg,
		agentId: params.route.agentId,
		isSelfChat: params.msg.chatType !== "group" && inboundPolicy.isSelfChat,
		pipelineResponsePrefix: replyPipeline.responsePrefix
	});
	const replyThreading = resolveBatchedReplyThreadingPolicy(account.replyToMode ?? "off", params.msg.isBatched === true);
	const conversationSystemPrompt = params.msg.chatType === "group" ? resolveWhatsAppGroupSystemPrompt({
		accountConfig: account,
		groupId: conversationId
	}) : resolveWhatsAppDirectSystemPrompt({
		accountConfig: account,
		peerId: dmRouteTarget ?? params.msg.from
	});
	const ctxPayload = buildWhatsAppInboundContext({
		bodyForAgent: msgForAgent.body,
		combinedBody,
		commandBody: params.msg.body,
		commandAuthorized,
		conversationId,
		groupHistory: visibleGroupHistory,
		groupMemberRoster: params.groupMemberNames.get(params.groupHistoryKey),
		groupSystemPrompt: conversationSystemPrompt,
		msg: params.msg,
		rawBody: params.msg.body,
		route: params.route,
		sender: {
			id: getPrimaryIdentityId(sender) ?? void 0,
			name: sender.name ?? void 0,
			e164: sender.e164 ?? void 0
		},
		...audioTranscript !== void 0 ? { transcript: audioTranscript } : {},
		...audioTranscript !== void 0 ? { mediaTranscribedIndexes: [0] } : {},
		replyThreading,
		visibleReplyTo: visibleReplyTo ?? void 0
	});
	emitWhatsAppMessageReceivedHooksIfEnabled({
		cfg: params.cfg,
		ctx: ctxPayload,
		accountId: params.route.accountId,
		sessionKey: params.route.sessionKey
	});
	const pinnedMainDmRecipient = resolvePinnedMainDmRecipient({
		cfg: params.cfg,
		allowFrom: inboundPolicy.configuredAllowFrom
	});
	updateWhatsAppMainLastRoute({
		backgroundTasks: params.backgroundTasks,
		cfg: params.cfg,
		ctx: ctxPayload,
		dmRouteTarget,
		pinnedMainDmRecipient,
		route: params.route,
		updateLastRoute: updateLastRouteInBackground,
		warn: params.replyLogger.warn.bind(params.replyLogger)
	});
	const turnResult = await runInboundReplyTurn({
		channel: "whatsapp",
		accountId: params.route.accountId,
		raw: params.msg,
		adapter: {
			ingest: () => ({
				id: params.msg.id ?? `${conversationId}:${Date.now()}`,
				timestamp: params.msg.timestamp,
				rawText: ctxPayload.RawBody ?? "",
				textForAgent: ctxPayload.BodyForAgent,
				textForCommands: ctxPayload.CommandBody,
				raw: params.msg
			}),
			resolveTurn: () => ({
				channel: "whatsapp",
				accountId: params.route.accountId,
				routeSessionKey: params.route.sessionKey,
				storePath,
				ctxPayload,
				recordInboundSession,
				record: {
					onRecordError: (err) => {
						params.replyLogger.warn({
							error: formatError(err),
							storePath,
							sessionKey: params.route.sessionKey
						}, "failed updating session meta");
					},
					trackSessionMetaTask: (task) => {
						trackBackgroundTask(params.backgroundTasks, task);
					}
				},
				runDispatch: () => dispatchWhatsAppBufferedReply({
					cfg: params.cfg,
					connectionId: params.connectionId,
					context: ctxPayload,
					conversationId,
					deliverReply: deliverWebReply,
					groupHistories: params.groupHistories,
					groupHistoryKey: params.groupHistoryKey,
					maxMediaBytes: params.maxMediaBytes,
					maxMediaTextChunkLimit: params.maxMediaTextChunkLimit,
					msg: params.msg,
					onModelSelected,
					rememberSentText: params.rememberSentText,
					replyLogger: params.replyLogger,
					replyPipeline: {
						...replyPipeline,
						responsePrefix
					},
					replyResolver: params.replyResolver,
					route: params.route,
					shouldClearGroupHistory
				})
			})
		}
	});
	const didSendReply = turnResult.dispatched ? turnResult.dispatchResult : false;
	removeAckReactionHandleAfterReply({
		removeAfterReply: Boolean(params.cfg.messages?.removeAckAfterReply && didSendReply),
		ackReaction,
		onError: (err) => {
			logAckFailure({
				log: logVerbose,
				channel: "whatsapp",
				target: `${params.msg.chatId ?? conversationId}/${params.msg.id ?? "unknown"}`,
				error: err
			});
		}
	});
	return didSendReply;
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor/on-message.ts
function createWebOnMessageHandler(params) {
	const processForRoute = async (cfg, msg, route, groupHistoryKey, opts) => {
		const processParams = {
			cfg,
			msg,
			route,
			groupHistoryKey,
			groupHistories: params.groupHistories,
			groupMemberNames: params.groupMemberNames,
			connectionId: params.connectionId,
			verbose: params.verbose,
			maxMediaBytes: params.maxMediaBytes,
			replyResolver: params.replyResolver,
			replyLogger: params.replyLogger,
			backgroundTasks: params.backgroundTasks,
			rememberSentText: params.echoTracker.rememberText,
			echoHas: params.echoTracker.has,
			echoForget: params.echoTracker.forget,
			buildCombinedEchoKey: params.echoTracker.buildCombinedKey
		};
		if (opts?.groupHistory !== void 0) processParams.groupHistory = opts.groupHistory;
		if (opts?.suppressGroupHistoryClear !== void 0) processParams.suppressGroupHistoryClear = opts.suppressGroupHistoryClear;
		if (opts?.preflightAudioTranscript !== void 0) processParams.preflightAudioTranscript = opts.preflightAudioTranscript;
		if (opts?.ackAlreadySent === true) processParams.ackAlreadySent = true;
		if (opts?.ackReaction !== void 0) processParams.ackReaction = opts.ackReaction;
		return processMessage(processParams);
	};
	return async (msg) => {
		const cfg = params.loadConfig?.() ?? params.cfg;
		const conversationId = msg.conversationId ?? msg.from;
		const peerId = resolvePeerId(msg);
		const baseRoute = resolveAgentRoute({
			cfg,
			channel: "whatsapp",
			accountId: msg.accountId,
			peer: {
				kind: msg.chatType === "group" ? "group" : "direct",
				id: peerId
			}
		});
		const route = msg.chatType === "group" ? resolveWhatsAppGroupSessionRoute(baseRoute) : baseRoute;
		const groupHistoryKey = msg.chatType === "group" ? buildGroupHistoryKey({
			channel: "whatsapp",
			accountId: route.accountId,
			peerKind: "group",
			peerId
		}) : route.sessionKey;
		const account = resolveWhatsAppAccount({
			cfg,
			accountId: route.accountId ?? msg.accountId ?? params.account.accountId
		});
		const baseMentionConfig = buildMentionConfig(cfg);
		if (msg.from === msg.to) logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
		if (params.echoTracker.has(msg.body)) {
			logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
			params.echoTracker.forget(msg.body);
			return;
		}
		let preflightAudioTranscript;
		const hasAudioBody = msg.mediaType?.startsWith("audio/") === true && msg.body === "<media:audio>";
		const canRunEarlyAudioPreflight = msg.chatType === "group" || msg.accessControlPassed === true;
		let ackAlreadySent = false;
		let ackReaction = null;
		const runAudioPreflightOnce = async () => {
			if (preflightAudioTranscript !== void 0 || !canRunEarlyAudioPreflight || !hasAudioBody || !msg.mediaPath) return;
			ackReaction = await maybeSendAckReaction({
				cfg,
				msg,
				agentId: route.agentId,
				sessionKey: route.sessionKey,
				conversationId,
				verbose: params.verbose,
				accountId: route.accountId,
				info: params.replyLogger.info.bind(params.replyLogger),
				warn: params.replyLogger.warn.bind(params.replyLogger)
			});
			ackAlreadySent = ackReaction !== null;
			try {
				const { transcribeFirstAudio } = await import("./audio-preflight.runtime-CrI7I1OZ.js");
				preflightAudioTranscript = await transcribeFirstAudio({
					ctx: {
						MediaPaths: [msg.mediaPath],
						MediaTypes: msg.mediaType ? [msg.mediaType] : void 0,
						From: msg.from,
						To: msg.to,
						Provider: "whatsapp",
						Surface: "whatsapp",
						OriginatingChannel: "whatsapp",
						OriginatingTo: conversationId,
						AccountId: route.accountId
					},
					cfg
				}) ?? null;
			} catch {
				preflightAudioTranscript = null;
			}
		};
		if (msg.chatType === "group") {
			const sender = getSenderIdentity(msg);
			const metaCtx = {
				From: msg.from,
				To: msg.to,
				SessionKey: route.sessionKey,
				AccountId: route.accountId,
				ChatType: msg.chatType,
				ConversationLabel: conversationId,
				GroupSubject: msg.groupSubject,
				SenderName: sender.name ?? void 0,
				SenderId: getPrimaryIdentityId(sender) ?? void 0,
				SenderE164: sender.e164 ?? void 0,
				Provider: "whatsapp",
				Surface: "whatsapp",
				OriginatingChannel: "whatsapp",
				OriginatingTo: conversationId
			};
			updateLastRouteInBackground({
				cfg,
				backgroundTasks: params.backgroundTasks,
				storeAgentId: route.agentId,
				sessionKey: route.sessionKey,
				channel: "whatsapp",
				to: conversationId,
				accountId: route.accountId,
				ctx: metaCtx,
				warn: params.replyLogger.warn.bind(params.replyLogger)
			});
			let gating = await applyGroupGating({
				cfg,
				msg,
				deferMissingMention: hasAudioBody && Boolean(msg.mediaPath),
				conversationId,
				groupHistoryKey,
				agentId: route.agentId,
				sessionKey: route.sessionKey,
				baseMentionConfig,
				authDir: account.authDir,
				selfChatMode: account.selfChatMode,
				groupHistories: params.groupHistories,
				groupHistoryLimit: params.groupHistoryLimit,
				groupMemberNames: params.groupMemberNames,
				logVerbose,
				replyLogger: params.replyLogger
			});
			if (!gating.shouldProcess && "needsMentionText" in gating && gating.needsMentionText === true) {
				await runAudioPreflightOnce();
				gating = await applyGroupGating({
					cfg,
					msg,
					...typeof preflightAudioTranscript === "string" ? { mentionText: preflightAudioTranscript } : {},
					conversationId,
					groupHistoryKey,
					agentId: route.agentId,
					sessionKey: route.sessionKey,
					baseMentionConfig,
					authDir: account.authDir,
					selfChatMode: account.selfChatMode,
					groupHistories: params.groupHistories,
					groupHistoryLimit: params.groupHistoryLimit,
					groupMemberNames: params.groupMemberNames,
					logVerbose,
					replyLogger: params.replyLogger
				});
			}
			if (!gating.shouldProcess) return;
		} else if (!msg.sender?.e164 && !msg.senderE164 && peerId && peerId.startsWith("+")) {
			const normalized = normalizeE164(peerId);
			if (normalized) {
				msg.sender = {
					...msg.sender,
					e164: normalized
				};
				msg.senderE164 = normalized;
			}
		}
		await runAudioPreflightOnce();
		if (await maybeBroadcastMessage({
			cfg,
			msg,
			peerId,
			route,
			groupHistoryKey,
			groupHistories: params.groupHistories,
			...preflightAudioTranscript !== void 0 ? { preflightAudioTranscript } : {},
			...ackAlreadySent && msg.chatType !== "group" ? { ackAlreadySent: true } : {},
			...ackReaction && msg.chatType !== "group" ? { ackReaction } : {},
			processMessage: (m, r, k, opts) => processForRoute(cfg, m, r, k, opts)
		})) return;
		await processForRoute(cfg, msg, route, groupHistoryKey, {
			...preflightAudioTranscript !== void 0 ? { preflightAudioTranscript } : {},
			...ackAlreadySent ? { ackAlreadySent: true } : {},
			...ackReaction ? { ackReaction } : {}
		});
	};
}
//#endregion
//#region extensions/whatsapp/src/auto-reply/monitor.ts
function isNonRetryableWebCloseStatus(statusCode) {
	return statusCode === 440;
}
let replyResolverRuntimePromise = null;
function loadReplyResolverRuntime() {
	replyResolverRuntimePromise ??= import("./reply-resolver.runtime.js");
	return replyResolverRuntimePromise;
}
function resolveWebMonitorConfigSnapshot(params) {
	const account = resolveWhatsAppAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	return {
		cfg: {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				whatsapp: {
					...params.cfg.channels?.whatsapp,
					ackReaction: account.ackReaction,
					messagePrefix: account.messagePrefix,
					allowFrom: account.allowFrom,
					groupAllowFrom: account.groupAllowFrom,
					groupPolicy: account.groupPolicy,
					textChunkLimit: account.textChunkLimit,
					chunkMode: account.chunkMode,
					mediaMaxMb: account.mediaMaxMb,
					blockStreaming: account.blockStreaming,
					groups: account.groups
				}
			}
		},
		account
	};
}
function normalizeReconnectAccountId(accountId) {
	return (accountId ?? "").trim() || "default";
}
function isNoListenerReconnectError(lastError) {
	return typeof lastError === "string" && /No active WhatsApp Web listener/i.test(lastError);
}
function resolveExplicitWhatsAppDebounceOverride(params) {
	const channel = params.sourceCfg?.channels?.whatsapp;
	if (!channel) return;
	const accountId = normalizeReconnectAccountId(params.accountId);
	const accountDebounce = resolveAccountEntry(channel.accounts, accountId)?.debounceMs;
	if (accountDebounce !== void 0) return accountDebounce;
	if (accountId !== "default") {
		const defaultAccountDebounce = resolveAccountEntry(channel.accounts, "default")?.debounceMs;
		if (defaultAccountDebounce !== void 0) return defaultAccountDebounce;
	}
	return channel.debounceMs;
}
function isRetryableAuthUnstableError(error) {
	return error instanceof WhatsAppAuthUnstableError || typeof error === "object" && error !== null && "code" in error && error.code === "whatsapp-auth-unstable";
}
async function clearTerminalWebAuthState(params) {
	try {
		const cleared = await logoutWeb({
			authDir: params.account.authDir,
			isLegacyAuthDir: params.account.isLegacyAuthDir,
			runtime: params.runtime
		});
		params.log.warn({
			accountId: params.account.accountId,
			cleared,
			healthState: params.healthState,
			status: params.statusLabel
		}, "web reconnect: cleared cached auth after terminal close");
	} catch (error) {
		params.log.warn({
			accountId: params.account.accountId,
			error: formatError(error),
			healthState: params.healthState,
			status: params.statusLabel
		}, "web reconnect: failed clearing cached auth after terminal close");
		params.runtime.error(`WhatsApp Web cleanup failed after terminal close (status ${params.statusLabel}). Run \`${formatCliCommand("openclaw channels logout --channel whatsapp")}\`, then relink with \`${formatCliCommand("openclaw channels login --channel whatsapp")}\`.`);
	}
}
const DEFAULT_TRANSPORT_TIMEOUT_MS = 300 * 1e3;
async function monitorWebChannel(verbose, listenerFactory = attachWebInboxToSocket, keepAlive = true, replyResolver, runtime = defaultRuntime, abortSignal, tuning = {}) {
	const activeReplyResolver = replyResolver ?? (await loadReplyResolverRuntime()).getReplyFromConfig;
	const runId = newConnectionId();
	const replyLogger = getChildLogger({
		module: "web-auto-reply",
		runId
	});
	const heartbeatLogger = getChildLogger({
		module: "web-heartbeat",
		runId
	});
	const reconnectLogger = getChildLogger({
		module: "web-reconnect",
		runId
	});
	const statusController = createWebChannelStatusController(tuning.statusSink);
	statusController.emit();
	const baseCfg = getRuntimeConfig();
	const sourceCfg = getRuntimeConfigSourceSnapshot();
	const { cfg, account } = resolveWebMonitorConfigSnapshot({
		cfg: baseCfg,
		accountId: tuning.accountId
	});
	const loadCurrentMonitorConfig = () => resolveWebMonitorConfigSnapshot({
		cfg: getRuntimeConfig(),
		accountId: account.accountId
	}).cfg;
	const maxMediaBytes = resolveWhatsAppMediaMaxBytes(account);
	const heartbeatSeconds = resolveHeartbeatSeconds(cfg, tuning.heartbeatSeconds);
	const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
	const socketTiming = resolveWhatsAppSocketTiming(cfg, tuning.socketTiming);
	const baseMentionConfig = buildMentionConfig(cfg);
	const groupHistoryLimit = account.historyLimit ?? cfg.channels?.whatsapp?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50;
	const groupHistories = /* @__PURE__ */ new Map();
	const groupMemberNames = /* @__PURE__ */ new Map();
	const groupMetadataCache = /* @__PURE__ */ new Map();
	const echoTracker = createEchoTracker({
		maxItems: 100,
		logVerbose
	});
	const sleep = tuning.sleep ?? ((ms, signal) => sleepWithAbort(ms, signal ?? abortSignal));
	const stopRequested = () => abortSignal?.aborted === true;
	const currentMaxListeners = process.getMaxListeners?.() ?? 10;
	if (process.setMaxListeners && currentMaxListeners < 50) process.setMaxListeners(50);
	let sigintStop = false;
	const handleSigint = () => {
		sigintStop = true;
	};
	process.once("SIGINT", handleSigint);
	const transportTimeoutMs = tuning.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
	const messageTimeoutMs = tuning.messageTimeoutMs ?? 1800 * 1e3;
	const watchdogCheckMs = tuning.watchdogCheckMs ?? 60 * 1e3;
	const controller = new WhatsAppConnectionController({
		accountId: account.accountId,
		authDir: account.authDir,
		verbose,
		keepAlive,
		heartbeatSeconds,
		transportTimeoutMs,
		messageTimeoutMs,
		watchdogCheckMs,
		reconnectPolicy,
		socketTiming,
		abortSignal,
		sleep,
		isNonRetryableStatus: isNonRetryableWebCloseStatus
	});
	try {
		while (true) {
			if (stopRequested()) break;
			const connectionId = newConnectionId();
			const inboundDebounceMs = resolveInboundDebounceMs({
				cfg,
				channel: "whatsapp",
				overrideMs: resolveExplicitWhatsAppDebounceOverride({
					cfg,
					sourceCfg,
					accountId: account.accountId
				})
			});
			const shouldDebounce = (msg) => {
				if (msg.mediaPath || msg.mediaType) return false;
				if (msg.location) return false;
				if (msg.replyToId || msg.replyToBody) return false;
				return !hasControlCommand(msg.body, cfg);
			};
			let connection;
			try {
				connection = await controller.openConnection({
					connectionId,
					createListener: async ({ sock, connection }) => {
						const onMessage = createWebOnMessageHandler({
							cfg,
							loadConfig: loadCurrentMonitorConfig,
							verbose,
							connectionId,
							maxMediaBytes,
							groupHistoryLimit,
							groupHistories,
							groupMemberNames,
							echoTracker,
							backgroundTasks: connection.backgroundTasks,
							replyResolver: activeReplyResolver,
							replyLogger,
							baseMentionConfig,
							account
						});
						return await (listenerFactory ?? attachWebInboxToSocket)({
							cfg,
							loadConfig: loadCurrentMonitorConfig,
							verbose,
							accountId: account.accountId,
							authDir: account.authDir,
							mediaMaxMb: account.mediaMaxMb,
							selfChatMode: account.selfChatMode,
							sendReadReceipts: account.sendReadReceipts,
							debounceMs: inboundDebounceMs,
							shouldDebounce,
							socketRef: controller.socketRef,
							shouldRetryDisconnect: () => !sigintStop && controller.shouldRetryDisconnect(),
							disconnectRetryPolicy: reconnectPolicy,
							disconnectRetryAbortSignal: controller.getDisconnectRetryAbortSignal(),
							groupMetadataCache,
							onMessage: async (msg) => {
								const inboundAt = Date.now();
								controller.noteInbound(inboundAt);
								statusController.noteInbound(inboundAt);
								await onMessage(msg);
							},
							sock
						});
					},
					onHeartbeat: (snapshot) => {
						const authAgeMs = getWebAuthAgeMs(account.authDir);
						const minutesSinceLastMessage = snapshot.lastInboundAt ? Math.floor((Date.now() - snapshot.lastInboundAt) / 6e4) : null;
						const logData = {
							connectionId: snapshot.connectionId,
							reconnectAttempts: snapshot.reconnectAttempts,
							messagesHandled: snapshot.handledMessages,
							lastInboundAt: snapshot.lastInboundAt,
							lastTransportActivityAt: snapshot.lastTransportActivityAt,
							authAgeMs,
							uptimeMs: snapshot.uptimeMs,
							...minutesSinceLastMessage !== null && minutesSinceLastMessage > 30 ? { minutesSinceLastMessage } : {}
						};
						statusController.noteTransportActivity(snapshot.lastTransportActivityAt);
						if (minutesSinceLastMessage && minutesSinceLastMessage > 30) heartbeatLogger.warn(logData, "⚠️ web gateway heartbeat - no messages in 30+ minutes");
						else heartbeatLogger.info(logData, "web gateway heartbeat");
					},
					onWatchdogTimeout: (snapshot) => {
						const now = Date.now();
						const transportSilentMs = now - snapshot.lastTransportActivityAt;
						const appBaselineAt = snapshot.lastInboundAt ?? snapshot.startedAt;
						const minutesSinceTransportActivity = Math.floor(transportSilentMs / 6e4);
						const minutesSinceAppActivity = Math.floor((now - appBaselineAt) / 6e4);
						const watchdogReason = transportSilentMs > transportTimeoutMs ? "transport-inactive" : "app-silent";
						statusController.noteWatchdogStale();
						heartbeatLogger.warn({
							connectionId: snapshot.connectionId,
							watchdogReason,
							minutesSinceTransportActivity,
							minutesSinceAppActivity,
							lastInboundAt: snapshot.lastInboundAt ? new Date(snapshot.lastInboundAt) : null,
							lastTransportActivityAt: new Date(snapshot.lastTransportActivityAt),
							messagesHandled: snapshot.handledMessages
						}, "WhatsApp watchdog timeout detected - forcing reconnect");
						whatsappHeartbeatLog.warn(`WhatsApp watchdog timeout (${watchdogReason}) - restarting connection`);
					}
				});
			} catch (error) {
				if (getStatusCode(error) === 428) {
					const retryDecision = controller.consumeReconnectAttempt();
					statusController.noteReconnectAttempts(retryDecision.reconnectAttempts);
					statusController.noteClose({
						statusCode: 428,
						error: formatError(error),
						reconnectAttempts: retryDecision.reconnectAttempts,
						healthState: retryDecision.healthState
					});
					if (retryDecision.action === "stop") {
						reconnectLogger.warn({
							connectionId,
							status: 428,
							reconnectAttempts: retryDecision.reconnectAttempts,
							maxAttempts: reconnectPolicy.maxAttempts
						}, "web reconnect: 428 during opening; max attempts reached");
						runtime.error(`WhatsApp Web connection closed during setup (status 428) after ${retryDecision.reconnectAttempts}/${reconnectPolicy.maxAttempts} attempts. Relink with \`${formatCliCommand("openclaw channels login --channel whatsapp")}\` if the issue persists.`);
						await controller.shutdown();
						break;
					}
					reconnectLogger.info({
						connectionId,
						status: 428,
						reconnectAttempts: retryDecision.reconnectAttempts,
						delayMs: retryDecision.delayMs
					}, "web reconnect: 428 during opening; retrying");
					runtime.error(`WhatsApp Web connection closed during setup (status 428). Retry ${retryDecision.reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDurationPrecise(retryDecision.delayMs ?? 0)}.`);
					try {
						await controller.waitBeforeRetry(retryDecision.delayMs ?? 0);
					} catch {
						break;
					}
					continue;
				}
				if (!isRetryableAuthUnstableError(error)) throw error;
				const retryDecision = controller.consumeReconnectAttempt();
				statusController.noteReconnectAttempts(retryDecision.reconnectAttempts);
				statusController.noteClose({
					error: error.message,
					reconnectAttempts: retryDecision.reconnectAttempts,
					healthState: retryDecision.healthState
				});
				if (retryDecision.action === "stop") {
					reconnectLogger.warn({
						connectionId,
						reconnectAttempts: retryDecision.reconnectAttempts,
						maxAttempts: reconnectPolicy.maxAttempts
					}, "web reconnect: auth state stayed unstable; max attempts reached");
					runtime.error(`WhatsApp auth state is still stabilizing after ${retryDecision.reconnectAttempts}/${reconnectPolicy.maxAttempts} attempts. Stopping web monitoring.`);
					await controller.shutdown();
					break;
				}
				reconnectLogger.info({
					connectionId,
					reconnectAttempts: retryDecision.reconnectAttempts,
					delayMs: retryDecision.delayMs
				}, "web reconnect: auth state still stabilizing during inbox attach; retrying");
				runtime.error(`WhatsApp auth state is still stabilizing. Retry ${retryDecision.reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} for inbox attach in ${formatDurationPrecise(retryDecision.delayMs ?? 0)}.`);
				try {
					await controller.waitBeforeRetry(retryDecision.delayMs ?? 0);
				} catch {
					break;
				}
				continue;
			}
			statusController.noteConnected();
			controller.setUnhandledRejectionCleanup(registerUnhandledRejectionHandler((reason) => {
				if (!isLikelyWhatsAppCryptoError(reason)) return false;
				const errorStr = formatError(reason);
				reconnectLogger.warn({
					connectionId: connection.connectionId,
					error: errorStr
				}, "web reconnect: unhandled rejection from WhatsApp socket; forcing reconnect");
				controller.forceClose({
					status: 499,
					isLoggedOut: false,
					error: reason
				});
				return true;
			}));
			const { e164: selfE164 } = readWebSelfId(account.authDir);
			const connectRoute = resolveAgentRoute({
				cfg,
				channel: "whatsapp",
				accountId: account.accountId
			});
			enqueueSystemEvent(`WhatsApp gateway connected${selfE164 ? ` as ${selfE164}` : ""}.`, {
				sessionKey: connectRoute.sessionKey,
				trusted: true
			});
			const normalizedAccountId = normalizeReconnectAccountId(account.accountId);
			drainPendingDeliveries({
				drainKey: `whatsapp:${normalizedAccountId}`,
				logLabel: "WhatsApp reconnect drain",
				cfg,
				log: reconnectLogger,
				selectEntry: (entry) => ({
					match: entry.channel === "whatsapp" && normalizeReconnectAccountId(entry.accountId) === normalizedAccountId,
					bypassBackoff: isNoListenerReconnectError(entry.lastError)
				})
			}).catch((err) => {
				reconnectLogger.warn({
					connectionId: connection.connectionId,
					error: String(err)
				}, "reconnect drain failed");
			});
			whatsappLog.info("Listening for personal WhatsApp inbound messages.");
			if (process.stdout.isTTY || process.stderr.isTTY) whatsappLog.raw("Ctrl+C to stop.");
			if (!keepAlive) {
				await controller.shutdown();
				return;
			}
			const reason = await controller.waitForClose();
			if (stopRequested() || sigintStop || reason === "aborted") {
				await controller.shutdown();
				break;
			}
			const decision = controller.resolveCloseDecision(reason);
			if (decision === "aborted") {
				await controller.shutdown();
				break;
			}
			statusController.noteReconnectAttempts(controller.getReconnectAttempts());
			reconnectLogger.info({
				connectionId: connection.connectionId,
				status: decision.normalized.statusLabel,
				loggedOut: decision.normalized.isLoggedOut,
				reconnectAttempts: decision.reconnectAttempts,
				error: decision.normalized.errorText
			}, "web reconnect: connection closed");
			enqueueSystemEvent(`WhatsApp gateway disconnected (status ${decision.normalized.statusLabel})`, {
				sessionKey: connectRoute.sessionKey,
				trusted: true
			});
			if (decision.action === "stop") {
				await controller.closeCurrentConnection();
				statusController.noteClose({
					statusCode: decision.normalized.statusCode,
					loggedOut: decision.normalized.isLoggedOut,
					error: decision.normalized.errorText,
					reconnectAttempts: decision.reconnectAttempts,
					healthState: decision.healthState
				});
				if (decision.healthState === "logged-out") {
					await clearTerminalWebAuthState({
						account,
						runtime,
						statusLabel: decision.normalized.statusLabel,
						healthState: decision.healthState,
						log: reconnectLogger
					});
					runtime.error(`WhatsApp session logged out. Run \`${formatCliCommand("openclaw channels login --channel whatsapp")}\` to relink.`);
				} else if (decision.healthState === "conflict") {
					await clearTerminalWebAuthState({
						account,
						runtime,
						statusLabel: decision.normalized.statusLabel,
						healthState: decision.healthState,
						log: reconnectLogger
					});
					reconnectLogger.warn({
						connectionId: connection.connectionId,
						status: decision.normalized.statusLabel,
						error: decision.normalized.errorText
					}, "web reconnect: non-retryable close status; stopping monitor");
					runtime.error(`WhatsApp Web connection closed (status ${decision.normalized.statusLabel}: session conflict). Resolve conflicting WhatsApp Web sessions, then relink with \`${formatCliCommand("openclaw channels login --channel whatsapp")}\`. Stopping web monitoring.`);
				} else {
					reconnectLogger.warn({
						connectionId: connection.connectionId,
						status: decision.normalized.statusLabel,
						reconnectAttempts: decision.reconnectAttempts,
						maxAttempts: reconnectPolicy.maxAttempts
					}, "web reconnect: max attempts reached; continuing in degraded mode");
					runtime.error(`WhatsApp Web reconnect: max attempts reached (${decision.reconnectAttempts}/${reconnectPolicy.maxAttempts}). Stopping web monitoring.`);
				}
				await controller.shutdown();
				break;
			}
			const isWatchdogRecoveryReconnect = decision.normalized.error === WHATSAPP_WATCHDOG_TIMEOUT_ERROR;
			statusController.noteClose({
				statusCode: decision.normalized.statusCode,
				error: decision.normalized.errorText,
				reconnectAttempts: decision.reconnectAttempts,
				healthState: decision.healthState,
				watchdogRecovery: isWatchdogRecoveryReconnect
			});
			reconnectLogger.info({
				connectionId: connection.connectionId,
				status: decision.normalized.statusLabel,
				reconnectAttempts: decision.reconnectAttempts,
				maxAttempts: reconnectPolicy.maxAttempts || "unlimited",
				delayMs: decision.delayMs
			}, "web reconnect: scheduling retry");
			const reconnectMessage = isWatchdogRecoveryReconnect ? `WhatsApp Web watchdog is recovering a stale connection (status ${decision.normalized.statusLabel}). Retry ${decision.reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDurationPrecise(decision.delayMs ?? 0)}.` : `WhatsApp Web connection closed (status ${decision.normalized.statusLabel}). Retry ${decision.reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDurationPrecise(decision.delayMs ?? 0)}… (${decision.normalized.errorText})`;
			if (isWatchdogRecoveryReconnect) runtime.log(warn(reconnectMessage));
			else runtime.error(reconnectMessage);
			await controller.closeCurrentConnection();
			try {
				await controller.waitBeforeRetry(decision.delayMs ?? 0);
			} catch {
				break;
			}
		}
	} finally {
		statusController.markStopped();
		process.removeListener("SIGINT", handleSigint);
		await controller.shutdown();
	}
}
//#endregion
export { monitorWebInbox as n, resetWebInboundDedupe as r, monitorWebChannel as t };
